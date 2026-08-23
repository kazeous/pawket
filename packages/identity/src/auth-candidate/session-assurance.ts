const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export function evaluateMfaAssurance(input: {
  primaryMethod: "password" | "google" | "discord";
  primaryAuthenticatedAt: Date;
  totpEnrolled: boolean;
  mfaVerifiedAt: Date | null;
}): { state: "active" } | { state: "mfa_pending"; expiresAt: Date } {
  if (
    input.totpEnrolled &&
    (!input.mfaVerifiedAt || input.mfaVerifiedAt < input.primaryAuthenticatedAt)
  ) {
    return {
      state: "mfa_pending",
      expiresAt: new Date(input.primaryAuthenticatedAt.getTime() + 10 * MINUTE_MS),
    };
  }
  return { state: "active" };
}

export function evaluateSessionLifetime(input: {
  role: "owner" | "user";
  createdAt: Date;
  lastUsedAt: Date;
  now: Date;
}): "active" | "expired" {
  const absoluteLifetime = input.role === "owner" ? 12 * 60 * MINUTE_MS : 30 * DAY_MS;
  const idleLifetime = input.role === "owner" ? 30 * MINUTE_MS : 7 * DAY_MS;
  return input.now.getTime() - input.createdAt.getTime() >= absoluteLifetime ||
    input.now.getTime() - input.lastUsedAt.getTime() >= idleLifetime
    ? "expired"
    : "active";
}
