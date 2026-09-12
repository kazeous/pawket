import { randomUUID } from "node:crypto";
import { appendAdminAuditEvent, insertOutboxEvent, paymentGuestCapabilities, paymentIntents, paymentTransferClaims, type PawketDatabase, type PawketTransaction } from "@pawket/database";
import { createLookupHmac, type EncryptionKeyring } from "@pawket/security";
import { eq } from "drizzle-orm";

import { TipPaymentError, requireIntegerVnd, type TipAccess, type TipInstructionProjection, type TipReceiptProjection, type TipTransferClaim } from "./tip-contracts.js";
import { readTipIntentSnapshot, tipInstructionProjection } from "./tip-snapshot.js";

type Intent = typeof paymentIntents.$inferSelect;
type Input = Readonly<{
  applicationRevision: string;
  db: PawketDatabase; paymentsMode: "disabled" | "manual_only";
  keyring: EncryptionKeyring; lookupHmacKey: Uint8Array;
  tips: { getTipOwnership(tx: PawketTransaction, tipId: string): Promise<Readonly<{ buyerUserId: string | null }> | null> };
  buyerAccounts: { isActiveTipBuyerAccount(tx: PawketTransaction, userId: string): Promise<boolean> };
  creatorEligibility: { getTipEligibility(tx: PawketTransaction, handle: string): Promise<Readonly<{ creatorUserId: string; receivingAccountVersionId: string }> | null> };
  claimRateLimit(creatorUserId: string): Promise<boolean>;
  now?: () => Date; idFactory?: () => string;
  onClaimCommitted?: (replayed: boolean) => void;
}>;
export type AuthorizedTipReceipt = Readonly<{ receipt: TipReceiptProjection; instruction: TipInstructionProjection | null }>;
function fail(code: ConstructorParameters<typeof TipPaymentError>[0]): never { throw new TipPaymentError(code); }
const referenceValid = (v: unknown): v is string => typeof v === "string" && v.trim() === v && /^PW[A-F0-9]{20}$/u.test(v);
const identifier = (v: unknown): v is string => typeof v === "string" && v.trim() === v && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(v);

export function createTipReceiptService(input: Input) {
  if (!identifier(input.applicationRevision)) fail("invalid_request");
  const key = new Uint8Array(input.lookupHmacKey); const clock = input.now ?? (() => new Date()); const id = input.idFactory ?? randomUUID;
  const digest = (context: string, value: string) => createLookupHmac({ key, context, value });
  const now = () => { const at = clock(); if (!(at instanceof Date) || !Number.isFinite(at.getTime())) fail("dependency_unavailable"); return new Date(at); };
  async function boundary<T>(run: () => Promise<T>, readOnly = false): Promise<T> {
    if (!readOnly && input.paymentsMode !== "manual_only") fail("payments_disabled");
    try { return await run(); } catch (error) { if (error instanceof TipPaymentError) throw error; return fail("dependency_unavailable"); }
  }
  async function find(tx: PawketTransaction, reference: string) {
    if (!referenceValid(reference)) fail("not_authorized");
    const [intent] = await tx.select().from(paymentIntents).where(eq(paymentIntents.referenceHash, digest("tip-transfer-reference", reference))).limit(1);
    if (!intent || intent.purpose !== "tip") fail("not_authorized");
    return intent;
  }
  async function authorize(tx: PawketTransaction, intent: Intent, access: TipAccess, at: Date, verifyActiveBuyer = true): Promise<{ buyerUserId: string | null; capabilityId: string | null }> {
    if (!access || (access.kind !== "buyer" && access.kind !== "guest")) fail("not_authorized");
    const ownership = await input.tips.getTipOwnership(tx, intent.tipId);
    if (!ownership || Object.keys(ownership).join() !== "buyerUserId") fail("not_authorized");
    if (access.kind === "buyer") {
      if (!identifier(access.userId) || ownership.buyerUserId !== access.userId || (verifyActiveBuyer && await input.buyerAccounts.isActiveTipBuyerAccount(tx, access.userId) !== true)) fail("not_authorized");
      return { buyerUserId: access.userId, capabilityId: null };
    }
    if (ownership.buyerUserId !== null || typeof access.capability !== "string" || access.capability.trim() !== access.capability || !/^[A-Za-z0-9_-]{43}$/u.test(access.capability)) fail("not_authorized");
    const [capability] = await tx.select().from(paymentGuestCapabilities).where(eq(paymentGuestCapabilities.paymentIntentId, intent.id)).limit(1);
    if (!capability || capability.expiresAt <= at || capability.capabilityHash !== digest("tip-guest-capability", access.capability)) fail("not_authorized");
    return { buyerUserId: null, capabilityId: capability.id };
  }
  function receipt(intent: Intent, transferReference: string, creator: TipReceiptProjection["creator"], at: Date, claimedAt: Date | null): TipReceiptProjection {
    const state = intent.state === "awaiting_transfer" && intent.expiresAt <= at ? "expired" : intent.state;
    if (state !== "awaiting_transfer" && state !== "confirmed" && state !== "expired" && state !== "rejected") fail("not_available");
    return Object.freeze({ reference: transferReference, creator: Object.freeze({ ...creator }), amountVnd: requireIntegerVnd(intent.amountVnd), currency: "VND",
      state, expiresAt: intent.expiresAt.toISOString(), confirmedAt: state === "confirmed" ? intent.closedAt!.toISOString() : null, transferClaimedAt: claimedAt?.toISOString() ?? null });
  }
  return {
    async readReceipt(command: { reference: string; access: TipAccess }): Promise<AuthorizedTipReceipt> {
      return boundary(() => input.db.transaction(async (tx) => {
        const candidate = await find(tx, command.reference);
        await authorize(tx, candidate, command.access, now(), false);
        const { snapshot, transferReference } = readTipIntentSnapshot(candidate, { keyring: input.keyring, lookupHmacKey: key });
        // Creator/page/account locks always precede the intent lock. Hidden or
        // retired creators retain a private receipt, but no active instruction.
        const creator = input.paymentsMode === "manual_only" && candidate.state === "awaiting_transfer" && candidate.expiresAt > now()
          ? await input.creatorEligibility.getTipEligibility(tx, snapshot.creator.handle) : null;
        await authorize(tx, candidate, command.access, now());
        const [intent] = await tx.select().from(paymentIntents).where(eq(paymentIntents.id, candidate.id)).limit(1).for("share");
        if (!intent) fail("not_authorized");
        const at = now(); await authorize(tx, intent, command.access, at, false);
        const [claim] = await tx.select({ claimedAt: paymentTransferClaims.claimedAt }).from(paymentTransferClaims).where(eq(paymentTransferClaims.paymentIntentId, intent.id)).limit(1);
        const result = receipt(intent, transferReference, snapshot.creator, at, claim?.claimedAt ?? null);
        const usable = result.state === "awaiting_transfer" && creator?.creatorUserId === intent.creatorUserId && creator.receivingAccountVersionId === intent.accountVersionId;
        return Object.freeze({ receipt: result, instruction: usable ? tipInstructionProjection(intent, snapshot, transferReference, result.transferClaimedAt) : null });
      }), true);
    },
    async reportTransfer(command: { reference: string; access: TipAccess; requestId: string }): Promise<TipTransferClaim> {
      return boundary(async () => {
        // Reserve the shared throttle budget after authorization, before holding
        // the business transaction. A throttle adapter must not need a second
        // connection while all pool connections wait on the same intent lock.
        const creatorUserId = await input.db.transaction(async (tx) => {
          const candidate = await find(tx, command.reference);
          const at = now(); await authorize(tx, candidate, command.access, at);
          if (candidate.state !== "awaiting_transfer" || candidate.expiresAt <= at) fail("intent_not_pending");
          return candidate.creatorUserId;
        });
        if (await input.claimRateLimit(creatorUserId) !== true) fail("rate_limited");
        let replayed = false;
        const committed = await input.db.transaction(async (tx) => {
          if (!identifier(command.requestId)) fail("invalid_request");
          const candidate = await find(tx, command.reference);
          await authorize(tx, candidate, command.access, now());
          const [intent] = await tx.select().from(paymentIntents).where(eq(paymentIntents.id, candidate.id)).limit(1).for("update");
          if (!intent) fail("not_authorized");
          const at = now(); const access = await authorize(tx, intent, command.access, at);
          if (intent.state !== "awaiting_transfer" || intent.expiresAt <= at) fail("intent_not_pending");
          const [existing] = await tx.select({ claimedAt: paymentTransferClaims.claimedAt }).from(paymentTransferClaims).where(eq(paymentTransferClaims.paymentIntentId, intent.id)).limit(1);
          if (existing) { replayed = true; return Object.freeze({ claimedAt: existing.claimedAt, authoritative: false }); }
          await tx.insert(paymentTransferClaims).values({ id: id(), paymentIntentId: intent.id, accessKind: access.buyerUserId ? "buyer" : "guest", buyerUserId: access.buyerUserId,
            guestCapabilityId: access.capabilityId, authoritative: false, requestId: command.requestId, claimedAt: at });
          await appendAdminAuditEvent(tx, { actorUserId: access.buyerUserId ?? "guest", subjectType: "payment_intent", subjectId: intent.id,
            action: "tip.transfer_claimed", outcome: "succeeded", afterState: { authoritative: false }, assurance: { method: access.buyerUserId ? "buyer_session" : "guest_receipt" },
            applicationRevision: input.applicationRevision, requestId: command.requestId, occurredAt: at });
          await insertOutboxEvent(tx, { eventType: "tip.transfer_claimed.v1", eventVersion: 1, aggregateType: "payment_intent", aggregateId: intent.id,
            payload: { paymentIntentId: intent.id, tipId: intent.tipId, creatorUserId: intent.creatorUserId, authoritative: false, correlationId: command.requestId }, occurredAt: at });
          return Object.freeze({ claimedAt: at, authoritative: false });
        });
        try { input.onClaimCommitted?.(replayed); } catch { /* Claims remain non-authoritative if telemetry fails. */ }
        return committed;
      });
    },
  };
}
