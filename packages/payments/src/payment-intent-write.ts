import { paymentIntents, type PawketTransaction } from "@pawket/database";
import { createLookupHmac, encryptSensitiveField, type EncryptionKeyring } from "@pawket/security";
import type { TipPaymentsMode } from "@pawket/config/increment-four";
import { TipPaymentError, requireIntegerVnd } from "./tip-contracts.js";
import { lockTipReceivingDestination, lockTipSettlementBinding } from "./tip-receiving-account.js";
import { createVietQrTransferInstruction } from "./vietqr.js";
import type { Snapshot } from "./tip-snapshot.js";
import type { PaymentPurpose } from "./payment-purpose.js";

type Input = Readonly<{
  keyring: EncryptionKeyring; lookupHmacKey: Uint8Array; paymentsMode: TipPaymentsMode;
  referenceFactory: () => string; onQrOutcome?: (outcome: "produced" | "failed") => void;
}>;
type Command = Readonly<{
  intentId: string; purpose: PaymentPurpose; creatorUserId: string; accountVersionId: string;
  amountVnd: number; creator: { displayName: string; handle: string }; abuseKeyHash: string;
  requestId: string; at: Date; expiresAt: Date;
}>;
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
function fail(code: ConstructorParameters<typeof TipPaymentError>[0]): never { throw new TipPaymentError(code); }

/** One writer and reference namespace for both products; the caller owns its aggregate. */
export async function insertTransferPaymentIntent(tx: PawketTransaction, input: Input, command: Command) {
  if (input.paymentsMode === "disabled") fail("payments_disabled");
  const ownerId = command.purpose.kind === "tip" ? command.purpose.tipId : command.purpose.orderId;
  if (!uuid(command.intentId) || !uuid(ownerId) || !uuid(command.accountVersionId) ||
    !Number.isFinite(command.at.getTime()) || !Number.isFinite(command.expiresAt.getTime()) || command.expiresAt <= command.at) fail("invalid_request");
  const amountVnd = requireIntegerVnd(command.amountVnd);
  if (command.purpose.kind === "commission" && (amountVnd < 50_000 || amountVnd > 50_000_000 || command.expiresAt.getTime() - command.at.getTime() !== 86_400_000)) fail("invalid_request");
  const destination = await lockTipReceivingDestination(tx, command.creatorUserId, command.at, input);
  if (!destination || destination.accountVersionId !== command.accountVersionId) fail("not_available");
  const settlement = await lockTipSettlementBinding(tx, destination, command.creatorUserId, input.paymentsMode);
  if (!settlement) fail("not_available");
  const snapshot: Snapshot = { version: 1, bankBin: destination.bankBin, bankName: destination.bankName,
    accountNumber: destination.accountNumber, accountName: destination.accountName, creator: { ...command.creator } };
  const destinationEnvelope = encryptSensitiveField({ keyring: input.keyring, plaintext: JSON.stringify(snapshot),
    binding: { recordType: "payment_intents", recordId: command.intentId, fieldName: "destination" } });
  for (let attempt = 0; attempt < 5; attempt++) {
    const transferReference = input.referenceFactory();
    if (typeof transferReference !== "string" || !/^PW[A-F0-9]{20}$/u.test(transferReference)) fail("dependency_unavailable");
    try { createVietQrTransferInstruction({ bankBin: destination.bankBin, accountNumber: destination.accountNumber, amountVnd, transferReference }); }
    catch (error) { try { input.onQrOutcome?.("failed"); } catch { /* Metric only. */ } throw error; }
    try { input.onQrOutcome?.("produced"); } catch { /* Metric only; does not establish a committed intent. */ }
    const [intent] = await tx.insert(paymentIntents).values({
      id: command.intentId, purpose: command.purpose.kind,
      tipId: command.purpose.kind === "tip" ? command.purpose.tipId : null,
      commissionOrderId: command.purpose.kind === "commission" ? command.purpose.orderId : null,
      creatorUserId: command.creatorUserId, amountVnd,
      // Never split these reference hashes by purpose: the entire account shares one namespace.
      referenceHash: createLookupHmac({ key: input.lookupHmacKey, context: "tip-transfer-reference", value: transferReference }),
      referenceEnvelope: encryptSensitiveField({ keyring: input.keyring, plaintext: transferReference,
        binding: { recordType: "payment_intents", recordId: command.intentId, fieldName: "transfer_reference" } }), destinationEnvelope,
      accountVersionId: destination.accountVersionId, ...settlement, abuseKeyHash: command.abuseKeyHash, requestId: command.requestId,
      createdAt: command.at, updatedAt: command.at, expiresAt: command.expiresAt,
    }).onConflictDoNothing({ target: paymentIntents.referenceHash }).returning();
    if (intent) return { intent, snapshot, transferReference };
  }
  return fail("dependency_unavailable");
}
