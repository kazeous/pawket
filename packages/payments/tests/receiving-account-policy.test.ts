import { describe, expect, test } from "vitest";

import * as payments from "../src/index.js";

type ReceivingAccountPolicy = {
  normalizeReceivingAccountProposal(input: {
    bankBin: string;
    accountNumber: string;
    accountHolderLabel: string;
    supportedBanks: Readonly<Record<string, string>>;
  }): {
    bankBin: string;
    bankName: string;
    accountNumber: string;
    accountHolderLabel: string;
    maskedSuffix: string;
  };
  fingerprintReceivingAccount(input: {
    bankBin: string;
    accountNumber: string;
    key: Uint8Array;
  }): string;
};

const policy = payments as unknown as Partial<ReceivingAccountPolicy>;
const supportedBanks = {
  "970415": "VietinBank",
  "970436": "Vietcombank",
} as const;

describe("receiving-account policy", () => {
  test("normalizes a configured bank account and derives its masked suffix", () => {
    // Break caught: accepting an unconfigured bank or deriving an unusable applicant-facing mask.
    expect(typeof policy.normalizeReceivingAccountProposal).toBe("function");
    expect(
      policy.normalizeReceivingAccountProposal!({
        bankBin: " 970436 ",
        accountNumber: " 001234567890 ",
        accountHolderLabel: "  NGUYEN   VAN A  ",
        supportedBanks,
      }),
    ).toEqual({
      bankBin: "970436",
      bankName: "Vietcombank",
      accountNumber: "001234567890",
      accountHolderLabel: "NGUYEN VAN A",
      maskedSuffix: "•••• 7890",
    });
  });

  test("rejects unsupported banks and malformed account fields", () => {
    // Break caught: persisting an account that cannot participate in the configured proof workflow.
    const normalize = policy.normalizeReceivingAccountProposal!;
    for (const input of [
      { bankBin: "970999", accountNumber: "001234567890", accountHolderLabel: "NGUYEN VAN A" },
      { bankBin: "970436", accountNumber: "12345", accountHolderLabel: "NGUYEN VAN A" },
      { bankBin: "970436", accountNumber: "00123A567890", accountHolderLabel: "NGUYEN VAN A" },
      { bankBin: "970436", accountNumber: "001234567890", accountHolderLabel: "A" },
    ]) {
      expect(() => normalize({ ...input, supportedBanks })).toThrow(
        "Receiving account is invalid",
      );
    }
  });

  test("creates a domain-separated stable fingerprint without embedding bank data", () => {
    // Break caught: using randomized ciphertext for equality or exposing raw bank data in a lookup key.
    expect(typeof policy.fingerprintReceivingAccount).toBe("function");
    const key = new Uint8Array(32).fill(7);
    const fingerprint = policy.fingerprintReceivingAccount!({
      bankBin: "970436",
      accountNumber: "001234567890",
      key,
    });

    expect(fingerprint).toMatch(/^hmac-sha256:v1:[A-Za-z0-9_-]{43}$/u);
    expect(fingerprint).not.toContain("970436");
    expect(fingerprint).not.toContain("001234567890");
    expect(
      policy.fingerprintReceivingAccount!({
        bankBin: "970436",
        accountNumber: "001234567890",
        key,
      }),
    ).toBe(fingerprint);
    expect(
      policy.fingerprintReceivingAccount!({
        bankBin: "970415",
        accountNumber: "001234567890",
        key,
      }),
    ).not.toBe(fingerprint);
  });
});
