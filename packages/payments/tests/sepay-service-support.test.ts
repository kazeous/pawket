import { describe, expect, test } from "vitest";
import { requireSePayAssurance } from "../src/sepay-service-support.js";

const at = new Date("2026-10-04T10:00:00Z");
const proof = {
  primaryAuthenticatedAt: new Date(at.getTime() - 400_000),
  mfaEnrolled: true,
  mfaVerifiedAt: new Date(at.getTime() - 299_000),
  sessionExpiresAt: new Date(at.getTime() + 3_600_000),
};

describe("SePay second-factor assurance", () => {
  test("fresh passkey second-factor evidence authorizes a payment step-up", () => {
    expect(requireSePayAssurance(proof, at, true)).toEqual(proof);
  });
  test.each([new Date(at.getTime() - 301_000), null])("rejects stale or missing second-factor evidence: %s", (mfaVerifiedAt) => {
    expect(() => requireSePayAssurance({ ...proof, mfaVerifiedAt }, at, true)).toThrow("totp_required");
  });
  test("a creator without an enrolled second factor can use fresh primary", () => {
    const primary = { ...proof, mfaEnrolled: false, mfaVerifiedAt: null };
    expect(requireSePayAssurance(primary, at, true)).toEqual(primary);
  });
});
