import { describe, expect, test } from "vitest";

import {
  assertSafeStructuredData,
  canonicalizeSafeStructuredData,
  constantTimeEqual,
  createEncryptionKeyring,
  createLookupHmac,
  decryptSensitiveField,
  encryptSensitiveField,
  hashOpaqueToken,
  sanitizeStructuredLogValue,
  verifyOpaqueTokenHash,
} from "../src/index.js";

const oldKey = Buffer.alloc(32, 1);
const activeKey = Buffer.alloc(32, 2);

describe("versioned field encryption", () => {
  test("round-trips with field-bound AAD and no plaintext snapshot", () => {
    const keyring = createEncryptionKeyring({
      activeKeyId: "pii-2026-08",
      keys: { "pii-2026-08": activeKey },
    });
    const binding = {
      recordType: "creator_application",
      recordId: "application-1",
      fieldName: "date_of_birth",
    } as const;
    const plaintext = "2000-02-29";
    const envelope = encryptSensitiveField({ plaintext, binding, keyring });

    expect(keyring).toEqual({ activeKeyId: "pii-2026-08" });
    expect(envelope).toEqual(
      expect.objectContaining({ version: 1, algorithm: "A256GCM", keyId: "pii-2026-08" }),
    );
    expect(JSON.stringify(envelope)).not.toContain(plaintext);
    expect(decryptSensitiveField({ envelope, binding, keyring })).toBe(plaintext);
    expect(() =>
      decryptSensitiveField({
        envelope,
        binding: { ...binding, recordId: "application-2" },
        keyring,
      }),
    ).toThrow("Sensitive data cryptography operation failed");
  });

  test("decrypts an old envelope while new writes use the rotated active key", () => {
    const oldKeyring = createEncryptionKeyring({
      activeKeyId: "pii-old",
      keys: { "pii-old": oldKey },
    });
    const binding = {
      recordType: "receiving_account",
      recordId: "account-1",
      fieldName: "account_number",
    } as const;
    const oldEnvelope = encryptSensitiveField({ plaintext: "0123456789", binding, keyring: oldKeyring });
    const rotated = createEncryptionKeyring({
      activeKeyId: "pii-current",
      keys: { "pii-old": oldKey, "pii-current": activeKey },
    });
    const newEnvelope = encryptSensitiveField({ plaintext: "9876543210", binding, keyring: rotated });

    expect(decryptSensitiveField({ envelope: oldEnvelope, binding, keyring: rotated })).toBe("0123456789");
    expect(newEnvelope.keyId).toBe("pii-current");
  });
});

describe("hashes and fingerprints", () => {
  test("purpose-binds opaque tokens and compares without raw string equality", () => {
    const token = "opaque-high-entropy-token";
    const storedHash = hashOpaqueToken(token, "password-reset");

    expect(storedHash).toMatch(/^sha256:v1:/);
    expect(storedHash).not.toContain(token);
    expect(verifyOpaqueTokenHash({ storedHash, candidateToken: token, purpose: "password-reset" })).toBe(true);
    expect(verifyOpaqueTokenHash({ storedHash, candidateToken: token, purpose: "email-verification" })).toBe(false);
    expect(verifyOpaqueTokenHash({ storedHash: "not-a-hash", candidateToken: token, purpose: "password-reset" })).toBe(false);
    expect(constantTimeEqual(Buffer.from("same"), Buffer.from("same"))).toBe(true);
    expect(constantTimeEqual(Buffer.from("short"), Buffer.from("different-length"))).toBe(false);
  });

  test("lookup HMAC is stable, keyed, and context-bound", () => {
    const first = createLookupHmac({ value: "0123456789", context: "bank-account", key: activeKey });
    expect(first).toBe(createLookupHmac({ value: "0123456789", context: "bank-account", key: activeKey }));
    expect(first).not.toBe(createLookupHmac({ value: "0123456789", context: "deposit-reference", key: activeKey }));
    expect(first).not.toContain("0123456789");
  });
});

describe("structured-data boundaries", () => {
  test.each(["outbox", "job", "metric"] as const)(
    "rejects sensitive %s data with a fixed safe error",
    (channel) => {
      const secret = "do-not-echo-this-secret";
      expect(() =>
        assertSafeStructuredData({ nested: { accountNumber: secret } }, channel),
      ).toThrow(`Unsafe ${channel} data`);
      try {
        canonicalizeSafeStructuredData({ nested: { accountNumber: secret } }, channel);
      } catch (error) {
        expect((error as Error).message).not.toContain(secret);
      }
    },
  );

  test("allows safe email-state facts while rejecting an email address field", () => {
    expect(() =>
      assertSafeStructuredData({ emailVerified: true, verificationMethod: "provider" }, "audit"),
    ).not.toThrow();
    expect(() =>
      assertSafeStructuredData({ email: "creator@example.invalid" }, "audit"),
    ).toThrow("Unsafe audit data");
  });

  test("deep-redacts increment-2 secrets without mutating caller data", () => {
    const input = {
      creator: { dateOfBirth: "2000-02-29" },
      bank: { account_number: "0123456789" },
      auth: { TOTP: "123456", recoveryCode: "RECOVERY-CODE" },
      request: { body: { portfolio: "private request body" } },
      safe: { aggregateId: "application-1", status: "submitted" },
    };
    const sanitized = sanitizeStructuredLogValue(input);

    expect(input.creator.dateOfBirth).toBe("2000-02-29");
    expect(JSON.stringify(sanitized)).not.toMatch(/2000-02-29|0123456789|123456|RECOVERY-CODE|private request body/);
    expect(sanitized).toEqual(
      expect.objectContaining({ safe: { aggregateId: "application-1", status: "submitted" } }),
    );
  });

  test("never serializes exception messages or unsupported objects into logs", () => {
    const secret = "secret-that-was-embedded-in-an-error";
    const sanitized = sanitizeStructuredLogValue({
      error: new Error(secret),
      buffer: Buffer.from(secret),
    });

    expect(JSON.stringify(sanitized)).not.toContain(secret);
    expect(sanitized).toEqual({
      error: { name: "Error", message: "[Redacted]" },
      buffer: "[Unsupported object]",
    });
  });
});
