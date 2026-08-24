import { createOTP } from "@better-auth/utils/otp";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createInMemoryRecoveryCodeBatch,
  InMemoryRecoveryCodeStore,
} from "../../src/auth-candidate/recovery-codes.js";
import {
  evaluateMfaAssurance,
  evaluateSessionLifetime,
} from "../../src/auth-candidate/session-assurance.js";
import { sessionAssuranceForPath } from "../../src/auth-candidate/session-fields.js";
import {
  InMemoryTotpStepStore,
  TotpReplayGuard,
} from "../../src/auth-candidate/totp-replay.js";

afterEach(() => vi.useRealTimers());

describe("MFA and step-up conformance", () => {
  test.each(["password", "google", "discord"] as const)(
    "%s primary authentication is MFA-pending when TOTP is enrolled",
    (primaryMethod) => {
      const primaryAuthenticatedAt = new Date("2026-08-24T00:00:00.000Z");

      expect(
        evaluateMfaAssurance({
          primaryMethod,
          primaryAuthenticatedAt,
          totpEnrolled: true,
          mfaVerifiedAt: null,
        }),
      ).toEqual({
        state: "mfa_pending",
        expiresAt: new Date("2026-08-24T00:10:00.000Z"),
      });
    },
  );

  test.each(["/sign-in/email", "/callback/google", "/callback/discord"])(
    "%s creates only primary assurance until TOTP succeeds",
    (path) => {
      const now = new Date("2026-08-24T00:00:00.000Z");
      expect(sessionAssuranceForPath(path, now)).toEqual({
        primaryAuthenticatedAt: now,
        mfaVerifiedAt: null,
        lastUsedAt: now,
      });
      expect(sessionAssuranceForPath("/two-factor/verify-totp", now).mfaVerifiedAt).toBe(now);
    },
  );

  test("enforces normal and owner absolute and idle lifetimes", () => {
    const now = new Date("2026-08-24T12:00:00.000Z");
    expect(
      evaluateSessionLifetime({
        role: "owner",
        createdAt: new Date("2026-08-24T01:00:00.000Z"),
        lastUsedAt: new Date("2026-08-24T11:31:00.000Z"),
        now,
      }),
    ).toBe("active");
    expect(
      evaluateSessionLifetime({
        role: "owner",
        createdAt: new Date("2026-08-24T00:00:00.000Z"),
        lastUsedAt: new Date("2026-08-24T11:30:00.000Z"),
        now,
      }),
    ).toBe("expired");
    expect(
      evaluateSessionLifetime({
        role: "user",
        createdAt: new Date("2026-07-25T12:00:00.000Z"),
        lastUsedAt: new Date("2026-08-17T12:00:00.000Z"),
        now,
      }),
    ).toBe("expired");
  });

  test("recovery codes are displayed once, stored only as hashes, single-use, and regenerated as a batch", async () => {
    const store = new InMemoryRecoveryCodeStore();
    const first = await createInMemoryRecoveryCodeBatch("user-1", store);

    expect(first.codes).toHaveLength(10);
    expect(store.snapshot().every((record) => record.codeHash.startsWith("sha256:"))).toBe(true);
    expect(JSON.stringify(store.snapshot())).not.toContain(first.codes[0]);
    await expect(store.consume("user-1", first.codes[0]!)).resolves.toBe(true);
    await expect(store.consume("user-1", first.codes[0]!)).resolves.toBe(false);

    const second = await createInMemoryRecoveryCodeBatch("user-1", store);
    await expect(store.consume("user-1", first.codes[1]!)).resolves.toBe(false);
    await expect(store.consume("user-1", second.codes[0]!)).resolves.toBe(true);
  });

  test("accepts one narrow-window TOTP step once, including concurrent replay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T00:00:15.000Z"));
    const secret = "candidate-totp-secret-value";
    const code = await createOTP(secret, { digits: 6, period: 30 }).totp();
    const store = new InMemoryTotpStepStore();
    const guard = new TotpReplayGuard(store);

    const [first, replay] = await Promise.all([
      guard.verifyAndConsume({ userId: "user-1", secret, code, now: new Date() }),
      guard.verifyAndConsume({ userId: "user-1", secret, code, now: new Date() }),
    ]);

    expect([first, replay].sort()).toEqual([false, true]);
    await expect(
      guard.verifyAndConsume({ userId: "user-1", secret, code, now: new Date() }),
    ).resolves.toBe(false);
  });
});
