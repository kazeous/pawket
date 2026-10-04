import { canonicalizeEmailAddress } from "./email-address.js";

export const OIDC_LEASE_MS = 300_000;
export const OIDC_TRANSACTION_MS = 600_000;
export const OIDC_PRIMARY_FRESH_MS = 900_000;
export const OIDC_MFA_FRESH_MS = 300_000;

export class OidcIdentityError extends Error {
  constructor(readonly code: "invalid_response" | "email_unverified" | "assurance_required" | "actor_changed" | "transaction_expired" | "session_revoked" | "identity_conflict" | "provider_unavailable" | "rate_limited" | "login_required") {
    super(code);
    this.name = "OidcIdentityError";
  }
}

export type OidcEvidence = Readonly<{
  issuer: string; subject: string; sid: string; email: string; canonicalEmail: string;
  emailVerified: boolean; name: string; primaryAt: Date; primaryMethod: "password" | "source";
  mfaStatus: "enrolled" | "not_enrolled" | "unknown"; mfaAt: Date | null; providerRevision: string;
}>;

function fail(): never { throw new OidcIdentityError("invalid_response"); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function boundedString(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) fail();
  return value;
}
function claimDate(value: unknown, now: Date): Date {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value * 1000 > now.getTime()) fail();
  const date = new Date(value * 1000);
  if (!Number.isFinite(date.getTime())) fail();
  return date;
}

/** Only call after the OIDC library has verified protocol, signature, audience and nonce.
 * pawket_assurance is an operator-owned scope mapping, never an editable user attribute.
 * This separate policy validation cannot turn an unverified JWT into trusted evidence.
 */
export function normalizeOidcEvidence(claims: unknown, options: { issuer: string; providerRevision: string; now: Date }): OidcEvidence {
  if (!Number.isFinite(options.now.getTime())) fail();
  const c = record(claims);
  if (c.iss !== options.issuer) fail();
  const subject = boundedString(c.sub, 255);
  const sid = boundedString(c.sid, 255);
  const email = boundedString(c.email, 254);
  let canonicalEmail: string;
  try { canonicalEmail = canonicalizeEmailAddress(email).canonical; } catch { return fail(); }
  if (typeof c.email_verified !== "boolean") fail();
  const evidence = record(c.pawket_assurance);
  if (evidence.version !== 1 || evidence.policy !== options.providerRevision) fail();
  const primaryAt = claimDate(c.auth_time, options.now);
  if (evidence.primary_at !== c.auth_time) fail();
  if (evidence.primary_method !== "password" && evidence.primary_method !== "source") fail();
  const mfaStatus = evidence.mfa_enrolled === true ? "enrolled" : evidence.mfa_enrolled === false ? "not_enrolled" : "unknown";
  const mfaAt = evidence.mfa_at === null || evidence.mfa_at === undefined ? null : claimDate(evidence.mfa_at, options.now);
  if (mfaAt && (mfaStatus !== "enrolled" || mfaAt < primaryAt)) fail();
  if (mfaAt && (!Array.isArray(c.amr) || !c.amr.includes("mfa"))) fail();
  const name = typeof c.name === "string" && c.name.trim() && c.name.length <= 100 ? c.name.trim() : "Người dùng Pawket";
  return Object.freeze({ issuer: options.issuer, subject, sid, email, canonicalEmail, emailVerified: c.email_verified,
    name, primaryAt, primaryMethod: evidence.primary_method, mfaStatus, mfaAt, providerRevision: options.providerRevision });
}

export function oidcLeaseDeadline(startedAt: Date, sessionExpiresAt: Date): Date {
  if (!Number.isFinite(startedAt.getTime()) || !Number.isFinite(sessionExpiresAt.getTime())) fail();
  return new Date(Math.min(startedAt.getTime() + OIDC_LEASE_MS, sessionExpiresAt.getTime()));
}

export function assertOidcStepUp(evidence: OidcEvidence, input: {
  expectedSubject: string; requestedAt: Date; now: Date; owner: boolean;
  primaryFreshMs?: number; mfaFreshMs?: number;
}): void {
  if (evidence.subject !== input.expectedSubject) throw new OidcIdentityError("actor_changed");
  const primaryFreshMs = input.primaryFreshMs ?? OIDC_PRIMARY_FRESH_MS;
  const mfaFreshMs = input.mfaFreshMs ?? OIDC_MFA_FRESH_MS;
  if (!Number.isSafeInteger(primaryFreshMs) || primaryFreshMs <= 0 || primaryFreshMs > OIDC_PRIMARY_FRESH_MS ||
    !Number.isSafeInteger(mfaFreshMs) || mfaFreshMs <= 0 || mfaFreshMs > OIDC_MFA_FRESH_MS ||
    !Number.isFinite(input.now.getTime()) || !Number.isFinite(input.requestedAt.getTime()) || input.now < input.requestedAt) fail();
  if (!evidence.emailVerified) throw new OidcIdentityError("email_unverified");
  // JWT seconds precision: a login in the same second as the request is valid,
  // but a fresh token from a previous authentication is not fresh primary proof.
  const earliest = Math.floor(input.requestedAt.getTime() / 1000) * 1000;
  if (evidence.primaryAt.getTime() < earliest || evidence.primaryAt > input.now ||
    input.now.getTime() - evidence.primaryAt.getTime() > primaryFreshMs || evidence.mfaStatus === "unknown") {
    throw new OidcIdentityError("assurance_required");
  }
  if (input.owner || evidence.mfaStatus === "enrolled") {
    if (evidence.mfaStatus !== "enrolled" || !evidence.mfaAt || evidence.mfaAt < evidence.primaryAt ||
      evidence.mfaAt > input.now || input.now.getTime() - evidence.mfaAt.getTime() > mfaFreshMs) {
      throw new OidcIdentityError("assurance_required");
    }
  }
}
