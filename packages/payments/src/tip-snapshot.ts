import type { paymentIntents } from "@pawket/database";
import { createLookupHmac, decryptSensitiveField, type EncryptionKeyring } from "@pawket/security";
import { TipPaymentError, requireIntegerVnd, type TipInstructionProjection } from "./tip-contracts.js";
import { createVietQrTransferInstruction, isVietQrDestinationSupported, VIETQR_RECEIVING_BANKS } from "./vietqr.js";
const referencePattern = /^PW[A-F0-9]{20}$/u;
const valid = (value: string, pattern: RegExp) => typeof value === "string" && value.trim() === value && pattern.test(value);
function fail(code: ConstructorParameters<typeof TipPaymentError>[0]): never { throw new TipPaymentError(code); }
export type Snapshot = { version: 1; bankBin: string; bankName: string; accountNumber: string; accountName: string; creator: { displayName: string; handle: string } };

export function tipInstructionProjection(row: typeof paymentIntents.$inferSelect, snapshot: Snapshot, transferReference: string, transferClaimedAt: string | null = null): TipInstructionProjection {
  const amountVnd = requireIntegerVnd(row.amountVnd);
  if (row.settlementLane !== "manual_attested" && row.settlementLane !== "provider_bound") fail("not_available");
  const qr = createVietQrTransferInstruction({ bankBin: snapshot.bankBin, accountNumber: snapshot.accountNumber, amountVnd, transferReference });
  return Object.freeze({ reference: transferReference, creator: Object.freeze({ ...snapshot.creator }), amountVnd, currency: "VND",
    state: "awaiting_transfer", expiresAt: row.expiresAt.toISOString(), confirmedAt: null, transferClaimedAt,
    settlementLane: row.settlementLane, confirmationSource: null,
    destination: Object.freeze({ bankBin: snapshot.bankBin, bankName: snapshot.bankName, accountNumber: snapshot.accountNumber, accountName: snapshot.accountName }), qrPayload: qr.payload });
}
export function readTipIntentSnapshot(row: typeof paymentIntents.$inferSelect, input: { keyring: EncryptionKeyring; lookupHmacKey: Uint8Array }): { snapshot: Snapshot; transferReference: string } {
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
      !valid(transferReference, referencePattern) || createLookupHmac({ key: input.lookupHmacKey, context: "tip-transfer-reference", value: transferReference }) !== row.referenceHash) fail("not_available");
    return { snapshot, transferReference };
  } catch { return fail("not_available"); }
}
