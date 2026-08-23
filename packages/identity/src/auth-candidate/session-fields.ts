export const candidateSessionAdditionalFields = {
  primaryAuthenticatedAt: {
    type: "date",
    required: false,
    input: false,
    returned: false,
  },
  mfaVerifiedAt: {
    type: "date",
    required: false,
    input: false,
    returned: false,
  },
  lastUsedAt: {
    type: "date",
    required: false,
    input: false,
    returned: false,
  },
} as const;

export function sessionAssuranceForPath(path: string, now: Date) {
  return {
    primaryAuthenticatedAt: now,
    mfaVerifiedAt: path === "/two-factor/verify-totp" ? now : null,
    lastUsedAt: now,
  };
}
