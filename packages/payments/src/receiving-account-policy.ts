import { createLookupHmac } from "@pawket/security";

const bankBinPattern = /^\d{6}$/u;
const accountNumberPattern = /^\d{6,20}$/u;

export class ReceivingAccountPolicyError extends Error {
  constructor() {
    super("Receiving account is invalid");
    this.name = "ReceivingAccountPolicyError";
  }
}

function invalid(): never {
  throw new ReceivingAccountPolicyError();
}

function normalizedHolderLabel(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  const length = Array.from(normalized).length;
  if (length < 2 || length > 100 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    invalid();
  }
  return normalized;
}

export type NormalizedReceivingAccountProposal = Readonly<{
  bankBin: string;
  bankName: string;
  accountNumber: string;
  accountHolderLabel: string;
  maskedSuffix: string;
}>;

export function normalizeReceivingAccountProposal(input: {
  bankBin: string;
  accountNumber: string;
  accountHolderLabel: string;
  supportedBanks: Readonly<Record<string, string>>;
}): NormalizedReceivingAccountProposal {
  const bankBin = input.bankBin.trim();
  const accountNumber = input.accountNumber.trim();
  if (!bankBinPattern.test(bankBin) || !accountNumberPattern.test(accountNumber)) invalid();
  const bankName = input.supportedBanks[bankBin]?.trim();
  if (!bankName || Array.from(bankName).length > 100) invalid();
  const accountHolderLabel = normalizedHolderLabel(input.accountHolderLabel);
  return {
    bankBin,
    bankName,
    accountNumber,
    accountHolderLabel,
    maskedSuffix: `•••• ${accountNumber.slice(-4)}`,
  };
}

export function fingerprintReceivingAccount(input: {
  bankBin: string;
  accountNumber: string;
  key: Uint8Array;
}): string {
  const bankBin = input.bankBin.trim();
  const accountNumber = input.accountNumber.trim();
  if (!bankBinPattern.test(bankBin) || !accountNumberPattern.test(accountNumber)) invalid();
  return createLookupHmac({
    value: JSON.stringify(["receiving-account-v1", bankBin, accountNumber]),
    context: "receiving-account",
    key: input.key,
  });
}
