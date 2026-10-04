import { describe, expect, test } from "vitest";
import { assertOidcStepUp, normalizeOidcEvidence, oidcLeaseDeadline } from "../src/oidc-policy.js";

const now = new Date("2026-09-27T10:00:00.000Z");
const seconds = now.getTime() / 1000;
const issuer = "https://identity.example/application/o/pawket/";
const options = { issuer, providerRevision: "pawket-v1", now };
function claims() { return { iss: issuer, sub: "subject-1", sid: "session-1", email: "Buyer@example.com", email_verified: true,
  auth_time: seconds, iat: seconds, amr: ["pwd", "mfa"],
  pawket_assurance: { version: 1, policy: "pawket-v1", primary_at: seconds, primary_method: "password", mfa_enrolled: true, mfa_at: seconds } }; }

describe("OIDC application assurance policy", () => {
  test.each([299_000, 300_000, 301_000])("preserves the owner second-factor freshness boundary at %s ms", (elapsed) => {
    const evidence = normalizeOidcEvidence(claims(), options);
    const check = () => assertOidcStepUp(evidence, { expectedSubject: evidence.subject,
      requestedAt: now, now: new Date(now.getTime() + elapsed), owner: true });
    if (elapsed > 300_000) expect(check).toThrow("assurance_required");
    else expect(check).not.toThrow();
  });
  test("only totp_* claims are unknown, not enrolled", () => {
    const c: Record<string, unknown> = claims();
    c.pawket_assurance = { version: 1, policy: "pawket-v1", primary_at: seconds, primary_method: "password", totp_enrolled: true, totp_at: seconds };
    const e = normalizeOidcEvidence(c, options);
    expect(e.mfaStatus).toBe("unknown"); expect(e.mfaAt).toBeNull();
    expect(() => assertOidcStepUp(e, { expectedSubject: e.subject, now, requestedAt: now, owner: true })).toThrow("assurance_required");
  });
  test.each([
    ["no mfa amr", { amr: ["pwd"] }, {}],
    ["mfa before primary", {}, { mfa_at: seconds - 1 }],
    ["not enrolled", {}, { mfa_enrolled: false }],
  ])("rejects second-factor time with %s", (_, top, assurance) => {
    const c: Record<string, unknown> = { ...claims(), ...top };
    c.pawket_assurance = { ...claims().pawket_assurance, ...assurance };
    expect(() => normalizeOidcEvidence(c, options)).toThrow("invalid_response");
  });
  test("accepts evidence pinned to provider policy and preserves actual authentication time", () => {
    const e = normalizeOidcEvidence(claims(), options);
    expect(e.canonicalEmail).toBe("buyer@example.com");
    expect(e.primaryAt).toEqual(now);
    expect(e.mfaAt).toEqual(now);
    assertOidcStepUp(e, { expectedSubject: e.subject, now, requestedAt: now, owner: true });
  });
  test.each(["iss", "sub", "sid", "auth_time", "pawket_assurance", "email_verified"])("rejects missing required %s", (field) => {
    const c: Record<string, unknown> = claims(); delete c[field];
    expect(() => normalizeOidcEvidence(c, options)).toThrow("invalid_response");
  });
  test("does not convert token issuance into fresh authentication", () => {
    const c = claims(); c.auth_time -= 600; c.pawket_assurance.primary_at -= 600; c.pawket_assurance.mfa_at -= 600;
    const e = normalizeOidcEvidence(c, options);
    expect(e.primaryAt.getTime()).toBe(now.getTime() - 600_000);
    expect(() => assertOidcStepUp(e, { expectedSubject: e.subject, now, requestedAt: now, owner: true })).toThrow("assurance_required");
  });
  test("mfa amr alone provides no MFA evidence", () => {
    const c: Record<string, unknown> = claims(); c.pawket_assurance = { ...claims().pawket_assurance, mfa_at: null };
    const e = normalizeOidcEvidence(c, options);
    expect(() => assertOidcStepUp(e, { expectedSubject: e.subject, now, requestedAt: now, owner: true })).toThrow("assurance_required");
  });
  test("missing enrollment is unknown, never an MFA opt-out", () => {
    const c: Record<string, unknown> = claims(); c.pawket_assurance = { ...claims().pawket_assurance, mfa_at: null, mfa_enrolled: undefined };
    const e = normalizeOidcEvidence(c, options);
    expect(e.mfaStatus).toBe("unknown");
    expect(() => assertOidcStepUp(e, { expectedSubject: e.subject, now, requestedAt: now, owner: false })).toThrow("assurance_required");
  });
  test("non-owner without MFA enrollment can use fresh primary, owner cannot", () => {
    const c: Record<string, unknown> = claims(); c.pawket_assurance = { ...claims().pawket_assurance, mfa_at: null, mfa_enrolled: false };
    const e = normalizeOidcEvidence(c, options);
    assertOidcStepUp(e, { expectedSubject: e.subject, now, requestedAt: now, owner: false });
    expect(() => assertOidcStepUp(e, { expectedSubject: e.subject, now, requestedAt: now, owner: true })).toThrow("assurance_required");
  });
  test.each(["future", "before_primary", "wrong_policy", "wrong_issuer", "missing_mfa"])("rejects invalid evidence: %s", (condition) => {
    const c = claims();
    if (condition === "future") c.pawket_assurance.mfa_at++;
    if (condition === "before_primary") c.pawket_assurance.mfa_at--;
    if (condition === "wrong_policy") c.pawket_assurance.policy = "other-project";
    if (condition === "wrong_issuer") c.iss = "https://other.example";
    if (condition === "missing_mfa") c.amr = ["pwd"];
    expect(() => normalizeOidcEvidence(c, options)).toThrow("invalid_response");
  });
  test("account switching and withdrawn verified email cannot produce a proof", () => {
    const e = normalizeOidcEvidence(claims(), options);
    expect(() => assertOidcStepUp(e, { expectedSubject: "another-user", now, requestedAt: now, owner: true })).toThrow("actor_changed");
    expect(() => assertOidcStepUp({ ...e, emailVerified: false }, { expectedSubject: e.subject, now, requestedAt: now, owner: true })).toThrow("email_unverified");
  });
  test("lease is capped from request start and by application session expiry", () => {
    expect(oidcLeaseDeadline(now, new Date(now.getTime() + 3_600_000))).toEqual(new Date(now.getTime() + 300_000));
    expect(oidcLeaseDeadline(now, new Date(now.getTime() + 50_000))).toEqual(new Date(now.getTime() + 50_000));
  });
});
