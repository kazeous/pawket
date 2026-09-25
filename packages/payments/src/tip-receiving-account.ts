import { isSePayAutomationEnabled, isTipPaymentsEnabled, type TipPaymentsMode } from "@pawket/config/increment-four";
import { paymentsSepayAccountCutovers, paymentsSepayConnections, type PawketTransaction } from "@pawket/database";
import { decryptSensitiveField, type EncryptionKeyring } from "@pawket/security";
import { eq } from "drizzle-orm";

import { fingerprintReceivingAccount } from "./receiving-account-policy.js";
import { isVietQrDestinationSupported, VIETQR_RECEIVING_BANKS } from "./vietqr.js";
import { lockPaymentAccountLineage } from "./payment-account-fence.js";

type Input = Readonly<{ keyring: EncryptionKeyring; lookupHmacKey: Uint8Array }>;
// Payments-internal decrypted facts. Never return this type from a Catalog port.
export type LockedTipReceivingDestination = Readonly<{
  accountVersionId: string; bankBin: string; bankName: string;
  accountNumber: string; accountName: string; accountFingerprint: string;
}>;

export async function lockTipReceivingDestination(
  tx: PawketTransaction, creatorUserId: string, at: Date, input: Input,
): Promise<LockedTipReceivingDestination | null> {
  const account = await lockPaymentAccountLineage(tx, creatorUserId);
  if (!account?.accountNumberEnvelope || !account.accountHolderLabelEnvelope || account.proofState !== "verified" ||
    !account.proofVerifiedAt || account.proofVerifiedAt > at || account.minimizedAt !== null) return null;
  try {
    const accountNumber = decryptSensitiveField({
      keyring: input.keyring, envelope: account.accountNumberEnvelope,
      binding: { recordType: "payments_receiving_account", recordId: account.id, fieldName: "account_number" },
    });
    const accountName = decryptSensitiveField({
      keyring: input.keyring, envelope: account.accountHolderLabelEnvelope,
      binding: { recordType: "payments_receiving_account", recordId: account.id, fieldName: "account_holder_label" },
    });
    if (!isVietQrDestinationSupported({ bankBin: account.bankBin, accountNumber }) ||
      account.bankName !== VIETQR_RECEIVING_BANKS[account.bankBin] ||
      accountName.trim().replace(/\s+/gu, " ") !== accountName ||
      /[\u0000-\u001f\u007f]/u.test(accountName) || Array.from(accountName).length < 2 || Array.from(accountName).length > 100 ||
      fingerprintReceivingAccount({ bankBin: account.bankBin, accountNumber, key: input.lookupHmacKey }) !== account.accountFingerprint) return null;
    return Object.freeze({
      accountVersionId: account.id, bankBin: account.bankBin, bankName: account.bankName,
      accountNumber, accountName, accountFingerprint: account.accountFingerprint,
    });
  } catch {
    // Neither corruption details nor decrypted receiving facts cross the port.
    return null;
  }
}

export type TipSettlementBinding = Readonly<{ settlementLane: "manual_attested"; cutoverId: null }> |
  Readonly<{ settlementLane: "provider_bound"; cutoverId: string }>;

/** Caller holds the physical-account and lineage fences from
 * lockTipReceivingDestination. No other creator may adopt a prior cutover. */
export async function lockTipSettlementBinding(tx: PawketTransaction, destination: LockedTipReceivingDestination, creatorUserId: string, mode: TipPaymentsMode): Promise<TipSettlementBinding | null> {
  if (!isTipPaymentsEnabled(mode)) return null;
  const [cutover] = await tx.select().from(paymentsSepayAccountCutovers).where(eq(paymentsSepayAccountCutovers.accountFingerprint, destination.accountFingerprint)).limit(1).for("share");
  if (!cutover) return Object.freeze({ settlementLane: "manual_attested", cutoverId: null });
  if (cutover.creatorUserId !== creatorUserId || !isSePayAutomationEnabled(mode)) return null;
  const [connection] = await tx.select().from(paymentsSepayConnections).where(eq(paymentsSepayConnections.id, cutover.connectionId)).limit(1).for("share");
  if (!connection || connection.creatorUserId !== creatorUserId || connection.accountVersionId !== destination.accountVersionId ||
    connection.accountFingerprint !== destination.accountFingerprint || connection.status !== "ready" || !connection.automationEnabled || !connection.currentRevisionId ||
    connection.providerEnvironment !== cutover.providerEnvironment || connection.providerTenantId !== cutover.providerTenantId || connection.providerAccountId !== cutover.providerAccountId) return null;
  return Object.freeze({ settlementLane: "provider_bound", cutoverId: cutover.id });
}

export function createTipReceivingAccountEligibilityPort(input: Input & { paymentsMode: TipPaymentsMode }) {
  return {
    async getCurrentTipReceivingAccount(tx: PawketTransaction, creatorUserId: string, at: Date): Promise<Readonly<{ accountVersionId: string }> | null> {
      const destination = await lockTipReceivingDestination(tx, creatorUserId, at, input);
      return destination && await lockTipSettlementBinding(tx, destination, creatorUserId, input.paymentsMode)
        ? Object.freeze({ accountVersionId: destination.accountVersionId }) : null;
    },
  };
}
