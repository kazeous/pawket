import { randomUUID, timingSafeEqual } from "node:crypto";
import { appendAdminAuditEvent, beginIdempotentCommand, completeIdempotentCommand, insertOutboxEvent, paymentConfirmations, paymentIntents, paymentTransferClaims, type PawketDatabase, type PawketTransaction } from "@pawket/database";
import { createLookupHmac, type EncryptionKeyring } from "@pawket/security";
import { and, desc, eq, gt, inArray, lt, lte, or, sql } from "drizzle-orm";

import { requireIntegerVnd, TipPaymentError, type CreatorTipProjection, type PaymentIntentState } from "./tip-contracts.js";
import { lockTipReceivingDestination } from "./tip-receiving-account.js";
import { readTipIntentSnapshot } from "./tip-snapshot.js";
import { readTipPortRecord } from "./tip-port-boundary.js";

type Actor = Readonly<{ userId: string; sessionId: string }>;
type Assurance = Readonly<{ primaryAuthenticatedAt: Date; totpEnrolled: boolean; totpVerifiedAt: Date | null; sessionExpiresAt: Date }>;
type GuestContent = Readonly<{ name: string | null; message: string | null }>;
type Intent = typeof paymentIntents.$inferSelect;
type Input = Readonly<{
  db: PawketDatabase; keyring: EncryptionKeyring; lookupHmacKey: Uint8Array; paymentsMode: "disabled" | "manual_only";
  pageSize: number; recentAuthMs: number; totpAuthMs: number;
  assurance: { getTipSessionAssurance(tx: PawketTransaction, actor: Actor, at: Date): Promise<Assurance | null> };
  tips: { completeTip(tx: PawketTransaction, command: { tipId: string; creatorUserId: string; amountVnd: number; at: Date }): Promise<boolean>;
    getConfirmedGuestContent(tx: PawketTransaction, command: { tipId: string; creatorUserId: string }): Promise<GuestContent | null> };
  now?: () => Date; idFactory?: () => string;
}>;
export type ConfirmCreatorTipCommand = Readonly<{ actor: Actor; paymentIntentId: string; observedAmountVnd: unknown; observedTransferReference: unknown;
  observedBankTransactionId: unknown; attestedReceived: unknown; idempotencyKey: string; requestId: string }>;
export type CreatorTipQueue = Readonly<{ items: readonly CreatorTipProjection[]; nextCursor: string | null }>;
const isUuid = (v: unknown): v is string => typeof v === "string" && v.trim() === v && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v);
const identifier = (v: unknown): v is string => typeof v === "string" && v.trim() === v && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(v);
const validDate = (v: unknown): v is Date => v instanceof Date && Number.isFinite(v.getTime());
function fail(code: ConstructorParameters<typeof TipPaymentError>[0]): never { throw new TipPaymentError(code); }

export function normalizeTipBankTransactionId(value: unknown): string {
  if (typeof value !== "string" || value.length > 120) fail("invalid_request");
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/u.test(normalized)) fail("invalid_request");
  return normalized.toUpperCase();
}

export function createCreatorTipPaymentService(input: Input) {
  if (!Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 100 ||
    !Number.isSafeInteger(input.recentAuthMs) || input.recentAuthMs < 60_000 || input.recentAuthMs > 900_000 ||
    !Number.isSafeInteger(input.totpAuthMs) || input.totpAuthMs < 30_000 || input.totpAuthMs > 300_000) fail("invalid_request");
  const key = new Uint8Array(input.lookupHmacKey); const id = input.idFactory ?? randomUUID; const clock = input.now ?? (() => new Date());
  const digest = (context: string, value: string) => createLookupHmac({ key, context, value });
  const now = () => { const at = clock(); if (!validDate(at)) fail("dependency_unavailable"); return new Date(at); };
  const actorValid = (actor: Actor) => { if (!actor || !identifier(actor.userId) || !identifier(actor.sessionId)) fail("not_authorized"); };
  async function boundary<T>(run: () => Promise<T>, readOnly = false): Promise<T> {
    if (!readOnly && input.paymentsMode !== "manual_only") fail("payments_disabled");
    try { return await run(); } catch (error) { if (error instanceof TipPaymentError) throw error; return fail("dependency_unavailable"); }
  }
  function validateAssurance(proof: Assurance | null, at: Date, fresh: boolean): Assurance {
    const fields = readTipPortRecord(proof, ["primaryAuthenticatedAt", "sessionExpiresAt", "totpEnrolled", "totpVerifiedAt"]);
    if (!fields || !validDate(fields.primaryAuthenticatedAt) || !validDate(fields.sessionExpiresAt) || typeof fields.totpEnrolled !== "boolean" ||
      (fields.totpVerifiedAt !== null && !validDate(fields.totpVerifiedAt))) fail("not_authorized");
    proof = { primaryAuthenticatedAt: fields.primaryAuthenticatedAt, sessionExpiresAt: fields.sessionExpiresAt, totpEnrolled: fields.totpEnrolled, totpVerifiedAt: fields.totpVerifiedAt };
    if (proof.sessionExpiresAt <= at) fail("not_authorized");
    const age = at.getTime() - proof.primaryAuthenticatedAt.getTime();
    if (age < 0 || (fresh && age > input.recentAuthMs)) fail("recent_auth_required");
    if (fresh && proof.totpEnrolled && (!proof.totpVerifiedAt || proof.totpVerifiedAt > at || proof.totpVerifiedAt < proof.primaryAuthenticatedAt || at.getTime() - proof.totpVerifiedAt.getTime() > input.totpAuthMs)) fail("totp_required");
    return proof;
  }
  function encodeCursor(row: Intent, actorUserId: string, state: PaymentIntentState): string {
    const body = Buffer.from(JSON.stringify([1, row.createdAt.toISOString(), row.id])).toString("base64url");
    return `${body}.${digest("tip-creator-cursor", JSON.stringify([actorUserId, state, body])).slice("hmac-sha256:v1:".length)}`;
  }
  function decodeCursor(value: string | undefined, actorUserId: string, state: PaymentIntentState) {
    if (value === undefined) return null;
    if (typeof value !== "string" || value.length > 400 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(value) || value.trim() !== value) fail("invalid_request");
    const [body, mac] = value.split(".") as [string, string];
    const expected = digest("tip-creator-cursor", JSON.stringify([actorUserId, state, body])).slice("hmac-sha256:v1:".length);
    if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) fail("invalid_request");
    try {
      const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== 1 || typeof parsed[1] !== "string" || !isUuid(parsed[2])) fail("invalid_request");
      const createdAt = new Date(parsed[1]); if (!validDate(createdAt) || createdAt.toISOString() !== parsed[1]) fail("invalid_request");
      return { createdAt, id: parsed[2] };
    } catch { return fail("invalid_request"); }
  }
  async function project(tx: PawketTransaction, row: Intent, at: Date, claimedAt: Date | null): Promise<CreatorTipProjection> {
    const { transferReference } = readTipIntentSnapshot(row, { keyring: input.keyring, lookupHmacKey: key });
    const state = row.state === "awaiting_transfer" && row.expiresAt <= at ? "expired" : row.state;
    const common = { id: row.id, reference: transferReference, amountVnd: requireIntegerVnd(row.amountVnd), expiresAt: row.expiresAt.toISOString(), transferClaimedAt: claimedAt?.toISOString() ?? null };
    if (state === "confirmed") {
      const fields = readTipPortRecord(await input.tips.getConfirmedGuestContent(tx, { tipId: row.tipId, creatorUserId: row.creatorUserId }), ["name", "message"]);
      const boundedText = (value: unknown, maximum: number): value is string | null => value === null || (typeof value === "string" && value.trim() === value &&
        value.normalize("NFC") === value && Array.from(value).length >= 1 && Array.from(value).length <= maximum && !/[\uD800-\uDFFF\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value));
      if (!fields || !boundedText(fields.name, 80) || !boundedText(fields.message, 280) || !row.closedAt) fail("dependency_unavailable");
      const guestContent = Object.freeze({ name: fields.name, message: fields.message });
      return Object.freeze({ ...common, state, confirmedAt: row.closedAt.toISOString(), guestContent });
    }
    if (state !== "awaiting_transfer" && state !== "expired" && state !== "rejected") fail("dependency_unavailable");
    return Object.freeze({ ...common, state, confirmedAt: null });
  }
  async function claimedAt(tx: PawketTransaction, intentId: string) {
    const [claim] = await tx.select({ at: paymentTransferClaims.claimedAt }).from(paymentTransferClaims).where(eq(paymentTransferClaims.paymentIntentId, intentId)).limit(1);
    return claim?.at ?? null;
  }
  return {
    async listQueue(command: { actor: Actor; state?: PaymentIntentState; cursor?: string }): Promise<CreatorTipQueue> {
      return boundary(() => input.db.transaction(async (tx) => {
        actorValid(command.actor);
        const state = command.state ?? "awaiting_transfer";
        if (!["awaiting_transfer", "confirmed", "expired", "rejected"].includes(state)) fail("invalid_request");
        const cursor = decodeCursor(command.cursor, command.actor.userId, state);
        validateAssurance(await input.assurance.getTipSessionAssurance(tx, command.actor, now()), now(), false);
        const at = now();
        const stateFilter = state === "awaiting_transfer" ? and(eq(paymentIntents.state, state), gt(paymentIntents.expiresAt, at))
          : state === "expired" ? or(eq(paymentIntents.state, state), and(eq(paymentIntents.state, "awaiting_transfer"), lte(paymentIntents.expiresAt, at))) : eq(paymentIntents.state, state);
        const rows = await tx.select().from(paymentIntents).where(and(eq(paymentIntents.creatorUserId, command.actor.userId), eq(paymentIntents.purpose, "tip"), stateFilter,
          cursor ? or(lt(paymentIntents.createdAt, cursor.createdAt), and(eq(paymentIntents.createdAt, cursor.createdAt), lt(paymentIntents.id, cursor.id))) : undefined,
        )).orderBy(desc(paymentIntents.createdAt), desc(paymentIntents.id)).limit(input.pageSize + 1);
        const page = rows.slice(0, input.pageSize);
        const claims = page.length ? await tx.select({ id: paymentTransferClaims.paymentIntentId, at: paymentTransferClaims.claimedAt }).from(paymentTransferClaims).where(inArray(paymentTransferClaims.paymentIntentId, page.map((row) => row.id))) : [];
        const claimMap = new Map(claims.map((claim) => [claim.id, claim.at]));
        const items: CreatorTipProjection[] = [];
        for (const row of page) items.push(await project(tx, row, at, claimMap.get(row.id) ?? null));
        return Object.freeze({ items: Object.freeze(items), nextCursor: rows.length > input.pageSize ? encodeCursor(page[page.length - 1]!, command.actor.userId, state) : null });
      }), true);
    },
    async confirm(command: ConfirmCreatorTipCommand): Promise<CreatorTipProjection> {
      return boundary(async () => {
        actorValid(command.actor);
        if (!isUuid(command.paymentIntentId) || !identifier(command.requestId) || typeof command.idempotencyKey !== "string" || command.idempotencyKey.trim() !== command.idempotencyKey || !/^[A-Za-z0-9._-]{8,200}$/u.test(command.idempotencyKey) || command.attestedReceived !== true) fail("invalid_request");
        const amountVnd = requireIntegerVnd(command.observedAmountVnd);
        const reference = command.observedTransferReference;
        if (typeof reference !== "string" || reference.trim() !== reference || !/^PW[A-F0-9]{20}$/u.test(reference)) fail("evidence_mismatch");
        const bankTransactionId = normalizeTipBankTransactionId(command.observedBankTransactionId);
        const actor = { ...command.actor }; const intentId = command.paymentIntentId; const requestId = command.requestId;
        const keyHash = digest("tip-confirm-command-key", command.idempotencyKey);
        const fingerprint = digest("tip-confirm-command", JSON.stringify([actor.userId, intentId, amountVnd, reference, bankTransactionId, true]));
        return input.db.transaction(async (tx) => {
          const [candidate] = await tx.select().from(paymentIntents).where(and(eq(paymentIntents.id, intentId), eq(paymentIntents.creatorUserId, actor.userId), eq(paymentIntents.purpose, "tip"))).limit(1);
          if (!candidate) fail("not_authorized");
          const startedAt = now();
          const started = await beginIdempotentCommand(tx, { actorUserId: actor.userId, commandScope: "payments.tip_confirm", keyHash, requestFingerprint: fingerprint, now: startedAt, expiresAt: new Date(startedAt.getTime() + 86_400_000) });
          if (started.kind !== "acquired" && started.kind !== "replay") fail("idempotency_conflict");
          const proof = validateAssurance(await input.assurance.getTipSessionAssurance(tx, actor, now()), now(), true);
          const destination = await lockTipReceivingDestination(tx, actor.userId, now(), { keyring: input.keyring, lookupHmacKey: key });
          if (!destination || destination.accountVersionId !== candidate.accountVersionId) fail("evidence_mismatch");
          const bankTransactionFingerprint = digest("tip-bank-transaction", JSON.stringify([destination.bankBin, destination.accountFingerprint, bankTransactionId]));
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`tip-bank:${bankTransactionFingerprint}`}, 0))`);
          const [intent] = await tx.select().from(paymentIntents).where(eq(paymentIntents.id, intentId)).limit(1).for("update");
          if (!intent || intent.creatorUserId !== actor.userId) fail("not_authorized");
          const at = now(); validateAssurance(proof, at, true);
          if (at < startedAt) fail("dependency_unavailable");
          const snapshot = readTipIntentSnapshot(intent, { keyring: input.keyring, lookupHmacKey: key });
          if (intent.amountVnd !== amountVnd || snapshot.transferReference !== reference || intent.accountVersionId !== destination.accountVersionId ||
            snapshot.snapshot.bankBin !== destination.bankBin || snapshot.snapshot.accountNumber !== destination.accountNumber) fail("evidence_mismatch");
          if (started.kind === "replay") {
            const [confirmation] = await tx.select().from(paymentConfirmations).where(eq(paymentConfirmations.paymentIntentId, intentId)).limit(1);
            if (intent.state !== "confirmed" || !confirmation || started.resultReference !== `tip-confirmed-v1:${confirmation.id}` || confirmation.idempotencyKeyHash !== keyHash || confirmation.bankTransactionFingerprint !== bankTransactionFingerprint) fail("idempotency_conflict");
            return project(tx, intent, at, await claimedAt(tx, intentId));
          }
          if (intent.state !== "awaiting_transfer" || intent.expiresAt <= at) fail("intent_not_pending");
          const confirmationId = id(); if (!isUuid(confirmationId)) fail("dependency_unavailable");
          const [confirmation] = await tx.insert(paymentConfirmations).values({ id: confirmationId, paymentIntentId: intentId, creatorUserId: actor.userId,
            accountVersionId: intent.accountVersionId, observedAmountVnd: amountVnd, referenceHash: intent.referenceHash, bankTransactionFingerprint,
            source: "creator_manual", attestedReceived: true, actorSessionId: actor.sessionId, primaryAuthenticatedAt: proof.primaryAuthenticatedAt,
            totpVerifiedAt: proof.totpEnrolled ? proof.totpVerifiedAt : null, idempotencyKeyHash: keyHash, requestId, confirmedAt: at,
          }).onConflictDoNothing({ target: paymentConfirmations.bankTransactionFingerprint }).returning({ id: paymentConfirmations.id });
          if (!confirmation) fail("bank_transaction_conflict");
          const [confirmed] = await tx.update(paymentIntents).set({ state: "confirmed", closedAt: at, updatedAt: at }).where(and(eq(paymentIntents.id, intentId), eq(paymentIntents.state, "awaiting_transfer"), gt(paymentIntents.expiresAt, at))).returning();
          if (!confirmed || !await input.tips.completeTip(tx, { tipId: intent.tipId, creatorUserId: actor.userId, amountVnd, at })) fail("intent_not_pending");
          await appendAdminAuditEvent(tx, { actorUserId: actor.userId, actorSessionId: actor.sessionId, subjectType: "payment_intent", subjectId: intentId,
            action: "tip.confirmed", outcome: "succeeded", beforeState: { state: "awaiting_transfer" }, afterState: { state: "confirmed", confirmationId },
            assurance: { method: proof.totpEnrolled ? "recent_primary_and_totp" : "recent_primary_auth" }, applicationRevision: "increment-4", requestId, occurredAt: at });
          await insertOutboxEvent(tx, { eventType: "tip.confirmed.v1", eventVersion: 1, aggregateType: "payment_intent", aggregateId: intentId,
            payload: { paymentIntentId: intentId, tipId: intent.tipId, creatorUserId: actor.userId, confirmationId, correlationId: requestId }, occurredAt: at });
          if (!await completeIdempotentCommand(tx, { recordId: started.recordId, resultReference: `tip-confirmed-v1:${confirmationId}`, completedAt: at })) fail("idempotency_conflict");
          return project(tx, confirmed, at, await claimedAt(tx, intentId));
        });
      });
    },
  };
}
