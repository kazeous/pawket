import { isTipPaymentsEnabled, type TipPaymentsMode } from "@pawket/config/increment-four";
import { timingSafeEqual } from "node:crypto";
import { paymentConfirmations, paymentIntents, paymentTransferClaims, type PawketDatabase, type PawketTransaction } from "@pawket/database";
import { createLookupHmac, type EncryptionKeyring } from "@pawket/security";
import { and, desc, eq, gt, inArray, lt, lte, or } from "drizzle-orm";

import { requireIntegerVnd, TipPaymentError, type CreatorTipProjection, type PaymentIntentState } from "./tip-contracts.js";
import { readTipIntentSnapshot } from "./tip-snapshot.js";
import { readTipPortRecord } from "./tip-port-boundary.js";
import { createManualPaymentConfirmationService } from "./manual-payment-service.js";
import { isTipPayment } from "./payment-purpose.js";

type Actor = Readonly<{ userId: string; sessionId: string }>;
type Assurance = Readonly<{ primaryAuthenticatedAt: Date; mfaEnrolled: boolean; mfaVerifiedAt: Date | null; sessionExpiresAt: Date }>;
type GuestContent = Readonly<{ name: string | null; message: string | null }>;
type Intent = typeof paymentIntents.$inferSelect;
type Input = Readonly<{
  applicationRevision: string;
  db: PawketDatabase; keyring: EncryptionKeyring; lookupHmacKey: Uint8Array; paymentsMode: TipPaymentsMode;
  pageSize: number; recentAuthMs: number; mfaAuthMs: number;
  assurance: { getTipSessionAssurance(tx: PawketTransaction, actor: Actor, at: Date): Promise<Assurance | null> };
  authorizeCommand?: (tx: PawketTransaction, actor: Actor) => Promise<void>;
  tips: { completeTip(tx: PawketTransaction, command: { tipId: string; creatorUserId: string; amountVnd: number; at: Date }): Promise<boolean>;
    getConfirmedGuestContent(tx: PawketTransaction, command: { tipId: string; creatorUserId: string }): Promise<GuestContent | null> };
  now?: () => Date; idFactory?: () => string;
  onCommitted?: (replayed: boolean) => void;
}>;
export type ConfirmCreatorTipCommand = Readonly<{ actor: Actor; paymentIntentId: string; observedAmountVnd: unknown; observedTransferReference: unknown;
  observedBankTransactionId: unknown; attestedReceived: unknown; idempotencyKey: string; requestId: string }>;
export type CreatorTipQueue = Readonly<{ items: readonly CreatorTipProjection[]; nextCursor: string | null }>;
const isUuid = (v: unknown): v is string => typeof v === "string" && v.trim() === v && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v);
const identifier = (v: unknown): v is string => typeof v === "string" && v.trim() === v && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(v);
const validDate = (v: unknown): v is Date => v instanceof Date && Number.isFinite(v.getTime());
function fail(code: ConstructorParameters<typeof TipPaymentError>[0]): never { throw new TipPaymentError(code); }

export { normalizeTipBankTransactionId } from "./manual-payment-service.js";

export function createCreatorTipPaymentService(input: Input) {
  if (!identifier(input.applicationRevision)) fail("invalid_request");
  if (!Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 100 ||
    !Number.isSafeInteger(input.recentAuthMs) || input.recentAuthMs < 60_000 || input.recentAuthMs > 3_600_000 ||
    !Number.isSafeInteger(input.mfaAuthMs) || input.mfaAuthMs < 30_000 || input.mfaAuthMs > 3_600_000) fail("invalid_request");
  const key = new Uint8Array(input.lookupHmacKey); const clock = input.now ?? (() => new Date());
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
    if (!isTipPayment(row)) fail("not_authorized");
    const { transferReference } = readTipIntentSnapshot(row, { keyring: input.keyring, lookupHmacKey: key });
    const state = row.state === "awaiting_transfer" && row.expiresAt <= at ? "expired" : row.state;
    const settlementLane = row.settlementLane;
    if (settlementLane !== "manual_attested" && settlementLane !== "provider_bound") fail("dependency_unavailable");
    const common = { id: row.id, reference: transferReference, amountVnd: requireIntegerVnd(row.amountVnd), expiresAt: row.expiresAt.toISOString(), transferClaimedAt: claimedAt?.toISOString() ?? null, settlementLane: settlementLane as "manual_attested" | "provider_bound" };
    if (state === "confirmed") {
      const [confirmation] = await tx.select({ source: paymentConfirmations.source }).from(paymentConfirmations).where(eq(paymentConfirmations.paymentIntentId, row.id)).limit(1);
      const confirmationSource = confirmation?.source;
      if (confirmationSource !== "creator_manual" && confirmationSource !== "sepay_automatic" && confirmationSource !== "creator_reviewed_sepay") fail("dependency_unavailable");
      const fields = readTipPortRecord(await input.tips.getConfirmedGuestContent(tx, { tipId: row.tipId, creatorUserId: row.creatorUserId }), ["name", "message"]);
      const boundedText = (value: unknown, maximum: number): value is string | null => value === null || (typeof value === "string" && value.trim() === value &&
        value.normalize("NFC") === value && Array.from(value).length >= 1 && Array.from(value).length <= maximum && !/[\uD800-\uDFFF\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value));
      if (!fields || !boundedText(fields.name, 80) || !boundedText(fields.message, 280) || !row.closedAt) fail("dependency_unavailable");
      const guestContent = Object.freeze({ name: fields.name, message: fields.message });
      return Object.freeze({ ...common, state, confirmationSource, confirmedAt: row.closedAt.toISOString(), guestContent });
    }
    if (state !== "awaiting_transfer" && state !== "expired" && state !== "rejected") fail("dependency_unavailable");
    return Object.freeze({ ...common, state, confirmedAt: null, confirmationSource: null });
  }
  async function claimedAt(tx: PawketTransaction, intentId: string) {
    const [claim] = await tx.select({ at: paymentTransferClaims.claimedAt }).from(paymentTransferClaims).where(eq(paymentTransferClaims.paymentIntentId, intentId)).limit(1);
    return claim?.at ?? null;
  }
  const confirmation = createManualPaymentConfirmationService<CreatorTipProjection>({ ...input, purpose: "tip",
    lockAggregate: async () => true,
    completeAggregate: (tx, { intent, at }) => isTipPayment(intent)
      ? input.tips.completeTip(tx, { tipId: intent.tipId, creatorUserId: intent.creatorUserId, amountVnd: intent.amountVnd, at }) : Promise.resolve(false),
    project: async (tx, intent, at) => project(tx, intent, at, await claimedAt(tx, intent.id)),
  });
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
    confirm: confirmation.confirm,
  };
}
