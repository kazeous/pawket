import { randomBytes, randomUUID } from "node:crypto";
import { paymentGuestCapabilities, paymentIntents, type PawketTransaction } from "@pawket/database";
import { createLookupHmac, decryptSensitiveField, encryptSensitiveField, type EncryptionKeyring } from "@pawket/security";
import { and, count, eq, gt, sql } from "drizzle-orm";

import { TipPaymentError, requireIntegerVnd, type GuestTipCapability, type IntegerVnd, type TipInstructionProjection } from "./tip-contracts.js";
import { lockTipReceivingDestination } from "./tip-receiving-account.js";
import { createVietQrTransferInstruction, isVietQrDestinationSupported, VIETQR_RECEIVING_BANKS } from "./vietqr.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const hmacPattern = /^hmac-sha256:v1:[A-Za-z0-9_-]{43}$/u;
const referencePattern = /^PW[A-F0-9]{20}$/u;
const secretPattern = /^[A-Za-z0-9_-]{43}$/u;
const valid = (value: string, pattern: RegExp) => typeof value === "string" && value.trim() === value && pattern.test(value);
function fail(code: ConstructorParameters<typeof TipPaymentError>[0]): never { throw new TipPaymentError(code); }

export type TipCreationPaymentResult = Readonly<{ instruction: TipInstructionProjection; guestCapability: GuestTipCapability | null }>;
type Input = Readonly<{
  keyring: EncryptionKeyring; lookupHmacKey: Uint8Array;
  intentTtlMs: number; guestReceiptTtlMs: number; openIpLimit: number; openCreatorLimit: number;
  idFactory?: () => string; referenceFactory?: () => string;
}>;
type Snapshot = { version: 1; bankBin: string; bankName: string; accountNumber: string; accountName: string; creator: { displayName: string; handle: string } };

export function createTipPaymentIntentPort(input: Input) {
  if (!Number.isSafeInteger(input.intentTtlMs) || input.intentTtlMs < 300_000 || input.intentTtlMs > 604_800_000 ||
    !Number.isSafeInteger(input.guestReceiptTtlMs) || input.guestReceiptTtlMs < Math.max(3_600_000, input.intentTtlMs) || input.guestReceiptTtlMs > 2_592_000_000 ||
    !Number.isInteger(input.openIpLimit) || input.openIpLimit < 1 || input.openIpLimit > 20 ||
    !Number.isInteger(input.openCreatorLimit) || input.openCreatorLimit < 1 || input.openCreatorLimit > 10_000) fail("invalid_request");
  const key = new Uint8Array(input.lookupHmacKey);
  const id = input.idFactory ?? randomUUID;
  const reference = input.referenceFactory ?? (() => `PW${randomBytes(10).toString("hex").toUpperCase()}`);
  const digest = (context: string, value: string) => createLookupHmac({ key, context, value });
  function receiptSecret(intentId: string, context: string) {
    if (!valid(context, secretPattern)) fail("not_authorized");
    return digest("tip-guest-receipt-secret", JSON.stringify([intentId, context])).slice("hmac-sha256:v1:".length);
  }
  function projection(row: typeof paymentIntents.$inferSelect, snapshot: Snapshot, transferReference: string): TipInstructionProjection {
    const amountVnd = requireIntegerVnd(row.amountVnd);
    const qr = createVietQrTransferInstruction({ bankBin: snapshot.bankBin, accountNumber: snapshot.accountNumber, amountVnd, transferReference });
    return Object.freeze({ reference: transferReference, creator: Object.freeze({ ...snapshot.creator }), amountVnd, currency: "VND",
      state: "awaiting_transfer", expiresAt: row.expiresAt.toISOString(), confirmedAt: null, transferClaimedAt: null,
      destination: Object.freeze({ bankBin: snapshot.bankBin, bankName: snapshot.bankName, accountNumber: snapshot.accountNumber, accountName: snapshot.accountName }), qrPayload: qr.payload });
  }
  function readSnapshot(row: typeof paymentIntents.$inferSelect): { snapshot: Snapshot; transferReference: string } {
    try {
      const snapshot = JSON.parse(decryptSensitiveField({ keyring: input.keyring, envelope: row.destinationEnvelope,
        binding: { recordType: "payment_intents", recordId: row.id, fieldName: "destination" } })) as Snapshot;
      const transferReference = decryptSensitiveField({ keyring: input.keyring, envelope: row.referenceEnvelope,
        binding: { recordType: "payment_intents", recordId: row.id, fieldName: "transfer_reference" } });
      if (!snapshot || snapshot.version !== 1 || Object.keys(snapshot).sort().join() !== "accountName,accountNumber,bankBin,bankName,creator,version" ||
        !isVietQrDestinationSupported(snapshot) || snapshot.bankName !== VIETQR_RECEIVING_BANKS[snapshot.bankBin] ||
        typeof snapshot.accountName !== "string" || snapshot.accountName.trim() !== snapshot.accountName || Array.from(snapshot.accountName).length < 2 || Array.from(snapshot.accountName).length > 100 ||
        !snapshot.creator || Object.keys(snapshot.creator).sort().join() !== "displayName,handle" ||
        typeof snapshot.creator.displayName !== "string" || Array.from(snapshot.creator.displayName).length < 1 || Array.from(snapshot.creator.displayName).length > 80 ||
        typeof snapshot.creator.handle !== "string" || snapshot.creator.handle.length < 3 || snapshot.creator.handle.length > 30 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(snapshot.creator.handle) ||
        !valid(transferReference, referencePattern) || digest("tip-transfer-reference", transferReference) !== row.referenceHash) fail("not_available");
      return { snapshot, transferReference };
    } catch { return fail("not_available"); }
  }
  return {
    // Call before Catalog's page lock; all creators sharing this abuse key serialize.
    async lockCreationAbuseKey(tx: PawketTransaction, abuseKeyHash: string) {
      if (!valid(abuseKeyHash, hmacPattern)) fail("invalid_request");
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`tip-create:${abuseKeyHash}`}, 0))`);
    },
    async assertOpenCapacity(tx: PawketTransaction, command: { creatorUserId: string; abuseKeyHash: string; at: Date }) {
      const pending = and(eq(paymentIntents.state, "awaiting_transfer"), gt(paymentIntents.expiresAt, command.at));
      const [ip] = await tx.select({ total: count() }).from(paymentIntents).where(and(pending, eq(paymentIntents.abuseKeyHash, command.abuseKeyHash)));
      const [creator] = await tx.select({ total: count() }).from(paymentIntents).where(and(pending, eq(paymentIntents.creatorUserId, command.creatorUserId)));
      if (!ip || !creator || ip.total >= input.openIpLimit || creator.total >= input.openCreatorLimit) fail("rate_limited");
    },
    async createIntent(tx: PawketTransaction, command: {
      tipId: string; creatorUserId: string; accountVersionId: string; amountVnd: IntegerVnd;
      creator: { displayName: string; handle: string }; guestContext: string | null; abuseKeyHash: string; requestId: string; at: Date;
    }): Promise<TipCreationPaymentResult> {
      const intentId = id();
      if (!valid(intentId, UUID)) fail("invalid_request");
      const destination = await lockTipReceivingDestination(tx, command.creatorUserId, command.at, { keyring: input.keyring, lookupHmacKey: key });
      if (!destination || destination.accountVersionId !== command.accountVersionId) fail("not_available");
      const snapshot: Snapshot = { version: 1, bankBin: destination.bankBin, bankName: destination.bankName,
        accountNumber: destination.accountNumber, accountName: destination.accountName, creator: { ...command.creator } };
      const destinationEnvelope = encryptSensitiveField({ keyring: input.keyring, plaintext: JSON.stringify(snapshot),
        binding: { recordType: "payment_intents", recordId: intentId, fieldName: "destination" } });
      for (let attempt = 0; attempt < 5; attempt++) {
        const transferReference = reference();
        if (!valid(transferReference, referencePattern)) fail("dependency_unavailable");
        // Validate the complete locked QR contract before persisting any intent.
        createVietQrTransferInstruction({ bankBin: destination.bankBin, accountNumber: destination.accountNumber, amountVnd: command.amountVnd, transferReference });
        const [intent] = await tx.insert(paymentIntents).values({ id: intentId, tipId: command.tipId, creatorUserId: command.creatorUserId,
          amountVnd: command.amountVnd, referenceHash: digest("tip-transfer-reference", transferReference),
          referenceEnvelope: encryptSensitiveField({ keyring: input.keyring, plaintext: transferReference,
            binding: { recordType: "payment_intents", recordId: intentId, fieldName: "transfer_reference" } }), destinationEnvelope,
          accountVersionId: destination.accountVersionId, abuseKeyHash: command.abuseKeyHash, requestId: command.requestId,
          createdAt: command.at, updatedAt: command.at, expiresAt: new Date(command.at.getTime() + input.intentTtlMs),
        }).onConflictDoNothing({ target: paymentIntents.referenceHash }).returning();
        if (!intent) continue;
        let guestCapability: GuestTipCapability | null = null;
        if (command.guestContext !== null) {
          const secret = receiptSecret(intent.id, command.guestContext);
          const expiresAt = new Date(command.at.getTime() + input.guestReceiptTtlMs);
          const capabilityId = id(); if (!valid(capabilityId, UUID)) fail("invalid_request");
          await tx.insert(paymentGuestCapabilities).values({ id: capabilityId, paymentIntentId: intent.id,
            capabilityHash: digest("tip-guest-capability", secret), createdAt: command.at, expiresAt });
          guestCapability = Object.freeze({ secret, expiresAt });
        }
        return Object.freeze({ instruction: projection(intent, snapshot, transferReference), guestCapability });
      }
      return fail("dependency_unavailable");
    },
    // Internal replay port: caller must first authorize the completed idempotency
    // record and the owning Tips aggregate. It is not a public receipt lookup.
    async replayIntent(tx: PawketTransaction, command: { tipId: string; creatorUserId: string; accountVersionId: string; guestContext: string | null; at: Date }): Promise<TipCreationPaymentResult> {
      const [intent] = await tx.select().from(paymentIntents).where(and(eq(paymentIntents.tipId, command.tipId), eq(paymentIntents.creatorUserId, command.creatorUserId))).limit(1).for("update");
      if (!intent) fail("not_available");
      if (intent.state !== "awaiting_transfer" || intent.expiresAt <= command.at) fail("intent_not_pending");
      if (intent.accountVersionId !== command.accountVersionId) fail("not_available");
      const [stored] = await tx.select().from(paymentGuestCapabilities).where(eq(paymentGuestCapabilities.paymentIntentId, intent.id)).limit(1);
      let guestCapability: GuestTipCapability | null = null;
      if (command.guestContext !== null) {
        const secret = receiptSecret(intent.id, command.guestContext);
        if (!stored || stored.expiresAt <= command.at || digest("tip-guest-capability", secret) !== stored.capabilityHash) fail("not_authorized");
        guestCapability = Object.freeze({ secret, expiresAt: stored.expiresAt });
      } else if (stored) fail("not_authorized");
      const { snapshot, transferReference } = readSnapshot(intent);
      return Object.freeze({ instruction: projection(intent, snapshot, transferReference), guestCapability });
    },
  };
}

export type TipPaymentIntentPort = ReturnType<typeof createTipPaymentIntentPort>;
