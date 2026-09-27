import { randomBytes, randomUUID } from "node:crypto";
import { paymentConfirmations, paymentIntents, paymentTransferClaims, paymentsSepayAccountCutovers, type PawketTransaction } from "@pawket/database";
import type { EncryptionKeyring } from "@pawket/security";
import { and, eq, gt } from "drizzle-orm";
import { insertTransferPaymentIntent } from "./payment-intent-write.js";
import { readPaymentPurpose } from "./payment-purpose.js";
import { lockTipReceivingDestination, lockTipSettlementBinding } from "./tip-receiving-account.js";
import { readTipIntentSnapshot, tipInstructionProjection } from "./tip-snapshot.js";
import { TipPaymentError, requireIntegerVnd, type TipInstructionProjection } from "./tip-contracts.js";
import { lockPaymentAccountLineage } from "./payment-account-fence.js";

export type CommissionPaymentMode = "disabled" | "manual_only" | "sepay_optional";
export type CommissionPaymentProjection = Readonly<{
  id: string; orderId: string; amountVnd: number; state: "awaiting_transfer" | "confirmed" | "expired" | "rejected";
  reference: string; expiresAt: string; confirmedAt: string | null; transferClaimedAt: string | null;
  settlementLane: "manual_attested" | "provider_bound";
  confirmationSource: "creator_manual" | "sepay_automatic" | "creator_reviewed_sepay" | null;
  destination: TipInstructionProjection["destination"];
  instruction: TipInstructionProjection | null;
}>;
type Input = Readonly<{
  keyring: EncryptionKeyring; lookupHmacKey: Uint8Array; paymentsMode: CommissionPaymentMode;
  idFactory?: () => string; referenceFactory?: () => string;
}>;
type Binding = { orderId: string; creatorUserId: string; at: Date };
type CloseReason = "payment_expired" | "buyer_cancelled" | "creator_cancelled" | "security_invalidated" | "eligibility_invalidated";
function fail(code: ConstructorParameters<typeof TipPaymentError>[0]): never { throw new TipPaymentError(code); }

/** Internal Orders port. Callers must authorize order ownership before projecting any payment. */
export function createCommissionPaymentIntentPort(input: Input) {
  const id = input.idFactory ?? randomUUID;
  const crypt = { keyring: input.keyring, lookupHmacKey: new Uint8Array(input.lookupHmacKey) };
  const reference = input.referenceFactory ?? (() => `PW${randomBytes(10).toString("hex").toUpperCase()}`);
  const filter = (command: Binding) => and(eq(paymentIntents.commissionOrderId, command.orderId), eq(paymentIntents.creatorUserId, command.creatorUserId), eq(paymentIntents.purpose, "commission"));
  return {
    async hasCurrentDestination(tx: PawketTransaction, command: Binding): Promise<boolean> {
      const [intent] = await tx.select().from(paymentIntents).where(filter(command)).limit(1);
      if (!intent) return false;
      const account = await lockPaymentAccountLineage(tx, command.creatorUserId);
      if (!account || account.id !== intent.accountVersionId || account.proofState !== "verified" || !account.proofVerifiedAt ||
        account.proofVerifiedAt > command.at || account.retiredAt !== null || account.minimizedAt !== null) return false;
      const [cutover] = await tx.select().from(paymentsSepayAccountCutovers).where(eq(paymentsSepayAccountCutovers.accountFingerprint, account.accountFingerprint)).limit(1);
      // Connection pauses/reconnects are reversible operational controls, not an account replacement.
      return cutover ? intent.settlementLane === "provider_bound" && intent.cutoverId === cutover.id && cutover.creatorUserId === command.creatorUserId
        : intent.settlementLane === "manual_attested" && intent.cutoverId === null;
    },
    async createIntent(tx: PawketTransaction, command: Binding & {
      accountVersionId: string; amountVnd: number; creator: { displayName: string; handle: string };
      abuseKeyHash: string; requestId: string;
    }): Promise<{ paymentIntentId: string }> {
      const { intent } = await insertTransferPaymentIntent(tx, { ...crypt, paymentsMode: input.paymentsMode, referenceFactory: reference }, {
        ...command, intentId: id(), purpose: { kind: "commission", orderId: command.orderId }, expiresAt: new Date(command.at.getTime() + 86_400_000),
      });
      return { paymentIntentId: intent.id };
    },
    async projectPayment(tx: PawketTransaction, command: Binding & { includeInstructions: boolean }): Promise<CommissionPaymentProjection | null> {
      const [intent] = await tx.select().from(paymentIntents).where(filter(command)).limit(1);
      if (!intent) return null;
      if (readPaymentPurpose(intent)?.kind !== "commission") fail("not_available");
      const { snapshot, transferReference } = readTipIntentSnapshot(intent, crypt);
      const [claim] = await tx.select().from(paymentTransferClaims).where(eq(paymentTransferClaims.paymentIntentId, intent.id)).limit(1);
      const [confirmation] = await tx.select().from(paymentConfirmations).where(eq(paymentConfirmations.paymentIntentId, intent.id)).limit(1);
      const state = intent.state === "awaiting_transfer" && intent.expiresAt <= command.at ? "expired" : intent.state;
      if (state !== "awaiting_transfer" && state !== "expired" && state !== "rejected" && state !== "confirmed") fail("not_available");
      const lane = intent.settlementLane;
      if (lane !== "manual_attested" && lane !== "provider_bound") fail("not_available");
      const source = confirmation?.source ?? null;
      if (source !== null && source !== "creator_manual" && source !== "sepay_automatic" && source !== "creator_reviewed_sepay") fail("not_available");
      let instruction: TipInstructionProjection | null = null;
      if (command.includeInstructions && state === "awaiting_transfer" && input.paymentsMode !== "disabled") {
        const destination = await lockTipReceivingDestination(tx, command.creatorUserId, command.at, crypt);
        const settlement = destination && await lockTipSettlementBinding(tx, destination, command.creatorUserId, input.paymentsMode);
        if (destination?.accountVersionId === intent.accountVersionId && settlement?.settlementLane === intent.settlementLane && settlement.cutoverId === intent.cutoverId) {
          instruction = tipInstructionProjection(intent, snapshot, transferReference, claim?.claimedAt.toISOString() ?? null);
        }
      }
      return Object.freeze({ id: intent.id, orderId: command.orderId, amountVnd: requireIntegerVnd(intent.amountVnd), state,
        reference: transferReference, expiresAt: intent.expiresAt.toISOString(), confirmedAt: state === "confirmed" ? intent.closedAt?.toISOString() ?? null : null,
        transferClaimedAt: claim?.claimedAt.toISOString() ?? null, settlementLane: lane, confirmationSource: source,
        destination: Object.freeze({ bankBin: snapshot.bankBin, bankName: snapshot.bankName, accountNumber: snapshot.accountNumber, accountName: snapshot.accountName }), instruction });
    },
    async claimTransfer(tx: PawketTransaction, command: Binding & { buyerUserId: string; requestId: string }): Promise<{ claimId: string; claimedAt: Date; created: boolean }> {
      if (input.paymentsMode === "disabled") fail("payments_disabled");
      const [intent] = await tx.select().from(paymentIntents).where(filter(command)).limit(1).for("update");
      if (!intent || intent.state !== "awaiting_transfer" || intent.expiresAt <= command.at) fail("intent_not_pending");
      const [existing] = await tx.select().from(paymentTransferClaims).where(eq(paymentTransferClaims.paymentIntentId, intent.id)).limit(1);
      if (existing) {
        if (existing.accessKind !== "buyer" || existing.buyerUserId !== command.buyerUserId) fail("not_authorized");
        return { claimId: existing.id, claimedAt: existing.claimedAt, created: false };
      }
      const claimId = id();
      await tx.insert(paymentTransferClaims).values({ id: claimId, paymentIntentId: intent.id, accessKind: "buyer", buyerUserId: command.buyerUserId,
        guestCapabilityId: null, requestId: command.requestId, claimedAt: command.at });
      return { claimId, claimedAt: command.at, created: true };
    },
    // Available while either intake or payment confirmation is paused. Orders closes/releases in the same transaction.
    async closeIntent(tx: PawketTransaction, command: Binding & { reason: CloseReason }): Promise<boolean> {
      const [intent] = await tx.select().from(paymentIntents).where(filter(command)).limit(1).for("update");
      if (!intent || intent.state !== "awaiting_transfer" || command.at < intent.createdAt) return false;
      const expired = command.reason === "payment_expired";
      if (expired ? command.at < intent.expiresAt : command.at >= intent.expiresAt) return false;
      const [closed] = await tx.update(paymentIntents).set({ state: expired ? "expired" : "rejected", rejectionReason: expired ? null : command.reason,
        closedAt: command.at, updatedAt: command.at }).where(and(eq(paymentIntents.id, intent.id), eq(paymentIntents.state, "awaiting_transfer"),
          expired ? undefined : gt(paymentIntents.expiresAt, command.at))).returning({ id: paymentIntents.id });
      return !!closed;
    },
  };
}
export type CommissionPaymentIntentPort = ReturnType<typeof createCommissionPaymentIntentPort>;
