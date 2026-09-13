import { paymentsReceivingAccountOnboarding, type PawketTransaction } from "@pawket/database";
import { decryptSensitiveField, type EncryptionKeyring } from "@pawket/security";
import { and, eq, isNotNull, isNull, lte } from "drizzle-orm";

import { fingerprintReceivingAccount } from "./receiving-account-policy.js";
import { isVietQrDestinationSupported, VIETQR_RECEIVING_BANKS } from "./vietqr.js";

type Input = Readonly<{ keyring: EncryptionKeyring; lookupHmacKey: Uint8Array }>;
// Payments-internal decrypted facts. Never return this type from a Catalog port.
export type LockedTipReceivingDestination = Readonly<{
  accountVersionId: string; bankBin: string; bankName: string;
  accountNumber: string; accountName: string; accountFingerprint: string;
}>;

export async function lockTipReceivingDestination(
  tx: PawketTransaction, creatorUserId: string, at: Date, input: Input,
): Promise<LockedTipReceivingDestination | null> {
  const [account] = await tx.select().from(paymentsReceivingAccountOnboarding).where(and(
    eq(paymentsReceivingAccountOnboarding.applicantUserId, creatorUserId),
    eq(paymentsReceivingAccountOnboarding.proofState, "verified"),
    lte(paymentsReceivingAccountOnboarding.proofVerifiedAt, at),
    isNull(paymentsReceivingAccountOnboarding.retiredAt), isNull(paymentsReceivingAccountOnboarding.minimizedAt),
    isNotNull(paymentsReceivingAccountOnboarding.accountNumberEnvelope),
    isNotNull(paymentsReceivingAccountOnboarding.accountHolderLabelEnvelope),
  )).limit(1).for("update");
  if (!account?.accountNumberEnvelope || !account.accountHolderLabelEnvelope) return null;
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

export function createTipReceivingAccountEligibilityPort(input: Input) {
  return {
    async getCurrentTipReceivingAccount(tx: PawketTransaction, creatorUserId: string, at: Date): Promise<Readonly<{ accountVersionId: string }> | null> {
      const destination = await lockTipReceivingDestination(tx, creatorUserId, at, input);
      return destination ? Object.freeze({ accountVersionId: destination.accountVersionId }) : null;
    },
  };
}
