import { randomUUID } from "node:crypto";
import { isTipPaymentsEnabled, type TipPaymentsMode } from "@pawket/config/increment-four";
import { appendAdminAuditEvent, beginIdempotentCommand, completeIdempotentCommand, insertOutboxEvent, paymentConfirmations, paymentIntents, type PawketDatabase, type PawketTransaction } from "@pawket/database";
import { createLookupHmac, type EncryptionKeyring } from "@pawket/security";
import { and, eq, gt, sql } from "drizzle-orm";
import { requireIntegerVnd, TipPaymentError } from "./tip-contracts.js";
import { readTipPortRecord } from "./tip-port-boundary.js";
import { lockTipReceivingDestination } from "./tip-receiving-account.js";
import { readTipIntentSnapshot } from "./tip-snapshot.js";
import { readPaymentPurpose } from "./payment-purpose.js";
import { retryPaymentAccountChange } from "./payment-account-fence.js";

type Actor = Readonly<{ userId: string; sessionId: string }>;
type Assurance = Readonly<{ primaryAuthenticatedAt: Date; mfaEnrolled: boolean; mfaVerifiedAt: Date | null; sessionExpiresAt: Date }>;
type Intent = typeof paymentIntents.$inferSelect;
type Input<T> = Readonly<{
  db: PawketDatabase; keyring: EncryptionKeyring; lookupHmacKey: Uint8Array;
  applicationRevision: string; paymentsMode: TipPaymentsMode; purpose: "tip" | "commission";
  recentAuthMs: number; mfaAuthMs: number;
  assurance: { getTipSessionAssurance(tx: PawketTransaction, actor: Actor, at: Date): Promise<Assurance | null> };
  authorizeCommand?: (tx: PawketTransaction, actor: Actor) => Promise<void>;
  lockAggregate(tx: PawketTransaction, intent: Intent, at: Date): Promise<boolean>;
  completeAggregate(tx: PawketTransaction, command: { intent: Intent; actor: Actor; at: Date; requestId: string }): Promise<boolean>;
  project(tx: PawketTransaction, intent: Intent, at: Date): Promise<T>;
  now?: () => Date; idFactory?: () => string; onCommitted?: (replayed: boolean) => void;
}>;
export type ConfirmManualPaymentCommand = Readonly<{ actor: Actor; paymentIntentId: string; observedAmountVnd: unknown; observedTransferReference: unknown;
  observedBankTransactionId: unknown; attestedReceived: unknown; idempotencyKey: string; requestId: string }>;
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

/** Shared transaction, assurance, account fence and evidence dedup for both purposes. */
export function createManualPaymentConfirmationService<T>(input: Input<T>) {
  if (!identifier(input.applicationRevision)) fail("invalid_request");
  if (!Number.isSafeInteger(input.recentAuthMs) || input.recentAuthMs < 60_000 || input.recentAuthMs > 3_600_000 ||
    !Number.isSafeInteger(input.mfaAuthMs) || input.mfaAuthMs < 30_000 || input.mfaAuthMs > 3_600_000) fail("invalid_request");
  const key = new Uint8Array(input.lookupHmacKey); const id = input.idFactory ?? randomUUID; const clock = input.now ?? (() => new Date());
  const digest = (context: string, value: string) => createLookupHmac({ key, context, value });
  const now = () => { const at = clock(); if (!validDate(at)) fail("dependency_unavailable"); return new Date(at); };
  const actorValid = (actor: Actor) => { if (!actor || !identifier(actor.userId) || !identifier(actor.sessionId)) fail("not_authorized"); };
  async function boundary<T>(run: () => Promise<T>, readOnly = false): Promise<T> {
    if (!readOnly && !isTipPaymentsEnabled(input.paymentsMode)) fail("payments_disabled");
    try { return await run(); } catch (error) { if (error instanceof TipPaymentError) throw error; return fail("dependency_unavailable"); }
  }
  function validateAssurance(proof: Assurance | null, at: Date, fresh: boolean): Assurance {
    const fields = readTipPortRecord(proof, ["primaryAuthenticatedAt", "sessionExpiresAt", "mfaEnrolled", "mfaVerifiedAt"]);
    if (!fields || !validDate(fields.primaryAuthenticatedAt) || !validDate(fields.sessionExpiresAt) || typeof fields.mfaEnrolled !== "boolean" ||
      (fields.mfaVerifiedAt !== null && !validDate(fields.mfaVerifiedAt))) fail("not_authorized");
    proof = { primaryAuthenticatedAt: fields.primaryAuthenticatedAt, sessionExpiresAt: fields.sessionExpiresAt, mfaEnrolled: fields.mfaEnrolled, mfaVerifiedAt: fields.mfaVerifiedAt };
    if (proof.sessionExpiresAt <= at) fail("not_authorized");
    const age = at.getTime() - proof.primaryAuthenticatedAt.getTime();
    if (age < 0 || (fresh && age > input.recentAuthMs)) fail("recent_auth_required");
    if (fresh && proof.mfaEnrolled && (!proof.mfaVerifiedAt || proof.mfaVerifiedAt > at || proof.mfaVerifiedAt < proof.primaryAuthenticatedAt || at.getTime() - proof.mfaVerifiedAt.getTime() > input.mfaAuthMs)) fail("totp_required");
    return proof;
  }
  return {
    async confirm(command: ConfirmManualPaymentCommand): Promise<T> {
      return boundary(async () => {
        actorValid(command.actor);
        if (!isUuid(command.paymentIntentId) || !identifier(command.requestId) || typeof command.idempotencyKey !== "string" || command.idempotencyKey.trim() !== command.idempotencyKey || !/^[A-Za-z0-9._-]{8,200}$/u.test(command.idempotencyKey) || command.attestedReceived !== true) fail("invalid_request");
        const amountVnd = requireIntegerVnd(command.observedAmountVnd);
        const reference = command.observedTransferReference;
        if (typeof reference !== "string" || reference.trim() !== reference || !/^PW[A-F0-9]{20}$/u.test(reference)) fail("evidence_mismatch");
        const bankTransactionId = normalizeTipBankTransactionId(command.observedBankTransactionId);
        const actor = { ...command.actor }; const intentId = command.paymentIntentId; const requestId = command.requestId;
        const keyHash = digest(`${input.purpose}-confirm-command-key`, command.idempotencyKey);
        const fingerprint = digest(`${input.purpose}-confirm-command`, JSON.stringify([actor.userId, intentId, amountVnd, reference, bankTransactionId, true]));
        let replayed = false;
        const committed = await retryPaymentAccountChange(() => input.db.transaction(async (tx) => {
          const [candidate] = await tx.select().from(paymentIntents).where(and(eq(paymentIntents.id, intentId), eq(paymentIntents.creatorUserId, actor.userId), eq(paymentIntents.purpose, input.purpose))).limit(1);
          if (!candidate) fail("not_authorized");
          if (candidate.settlementLane !== "manual_attested") fail("evidence_mismatch");
          const startedAt = now();
          const started = await beginIdempotentCommand(tx, { actorUserId: actor.userId, commandScope: `payments.${input.purpose}_confirm`, keyHash, requestFingerprint: fingerprint, now: startedAt, expiresAt: new Date(startedAt.getTime() + 86_400_000) });
          if (started.kind !== "acquired" && started.kind !== "replay") fail("idempotency_conflict");
          if (!await input.lockAggregate(tx, candidate, now())) fail("not_available");
          const proof = validateAssurance(await input.assurance.getTipSessionAssurance(tx, actor, now()), now(), true);
          const destination = await lockTipReceivingDestination(tx, actor.userId, now(), { keyring: input.keyring, lookupHmacKey: key });
          if (!destination || destination.accountVersionId !== candidate.accountVersionId) fail("evidence_mismatch");
          const bankTransactionFingerprint = digest("tip-bank-transaction", JSON.stringify([destination.bankBin, destination.accountFingerprint, bankTransactionId]));
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`tip-bank:${bankTransactionFingerprint}`}, 0))`);
          const [intent] = await tx.select().from(paymentIntents).where(eq(paymentIntents.id, intentId)).limit(1).for("update");
          if (!intent || readPaymentPurpose(intent)?.kind !== input.purpose || intent.creatorUserId !== actor.userId) fail("not_authorized");
          if (intent.settlementLane !== "manual_attested" || intent.cutoverId !== null) fail("evidence_mismatch");
          const at = now(); validateAssurance(proof, at, true);
          await input.authorizeCommand?.(tx, actor);
          if (at < startedAt) fail("dependency_unavailable");
          const snapshot = readTipIntentSnapshot(intent, { keyring: input.keyring, lookupHmacKey: key });
          if (intent.amountVnd !== amountVnd || snapshot.transferReference !== reference || intent.accountVersionId !== destination.accountVersionId ||
            snapshot.snapshot.bankBin !== destination.bankBin || snapshot.snapshot.accountNumber !== destination.accountNumber) fail("evidence_mismatch");
          if (started.kind === "replay") {
            replayed = true;
            const [confirmation] = await tx.select().from(paymentConfirmations).where(eq(paymentConfirmations.paymentIntentId, intentId)).limit(1);
            if (intent.state !== "confirmed" || !confirmation || started.resultReference !== `${input.purpose}-confirmed-v1:${confirmation.id}` || confirmation.idempotencyKeyHash !== keyHash || confirmation.bankTransactionFingerprint !== bankTransactionFingerprint) fail("idempotency_conflict");
            return input.project(tx, intent, at);
          }
          if (intent.state !== "awaiting_transfer" || intent.expiresAt <= at) fail("intent_not_pending");
          const confirmationId = id(); if (!isUuid(confirmationId)) fail("dependency_unavailable");
          const [confirmation] = await tx.insert(paymentConfirmations).values({ id: confirmationId, paymentIntentId: intentId, creatorUserId: actor.userId,
            accountVersionId: intent.accountVersionId, observedAmountVnd: amountVnd, referenceHash: intent.referenceHash, bankTransactionFingerprint,
            source: "creator_manual", attestedReceived: true, actorSessionId: actor.sessionId, primaryAuthenticatedAt: proof.primaryAuthenticatedAt,
            mfaVerifiedAt: proof.mfaEnrolled ? proof.mfaVerifiedAt : null, idempotencyKeyHash: keyHash, requestId, confirmedAt: at,
          }).onConflictDoNothing({ target: paymentConfirmations.bankTransactionFingerprint }).returning({ id: paymentConfirmations.id });
          if (!confirmation) fail("bank_transaction_conflict");
          const [confirmed] = await tx.update(paymentIntents).set({ state: "confirmed", closedAt: at, updatedAt: at }).where(and(eq(paymentIntents.id, intentId), eq(paymentIntents.state, "awaiting_transfer"), gt(paymentIntents.expiresAt, at))).returning();
          if (!confirmed || !await input.completeAggregate(tx, { intent, actor, at, requestId })) fail("intent_not_pending");
          await appendAdminAuditEvent(tx, { actorUserId: actor.userId, actorSessionId: actor.sessionId, subjectType: "payment_intent", subjectId: intentId,
            action: `${input.purpose}.confirmed`, outcome: "succeeded", beforeState: { state: "awaiting_transfer" }, afterState: { state: "confirmed", confirmationId },
            assurance: { method: proof.mfaEnrolled ? "recent_primary_and_mfa" : "recent_primary_auth" }, applicationRevision: input.applicationRevision, requestId, occurredAt: at });
          await insertOutboxEvent(tx, { eventType: `${input.purpose}.confirmed.v1`, eventVersion: 1, aggregateType: "payment_intent", aggregateId: intentId,
            payload: { paymentIntentId: intentId, ...(input.purpose === "tip" ? { tipId: intent.tipId } : { orderId: intent.commissionOrderId }), creatorUserId: actor.userId, confirmationId, correlationId: requestId }, occurredAt: at });
          if (!await completeIdempotentCommand(tx, { recordId: started.recordId, resultReference: `${input.purpose}-confirmed-v1:${confirmationId}`, completedAt: at })) fail("idempotency_conflict");
          return input.project(tx, confirmed, at);
        }));
        try { input.onCommitted?.(replayed); } catch { /* A metric failure never changes the committed result. */ }
        return committed;
      });
    },
  };
}
