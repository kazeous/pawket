export const candidateAuthPolicy = {
  account: {
    accountLinking: {
      enabled: true,
      disableImplicitLinking: true,
      allowDifferentEmails: false,
    },
    storeStateStrategy: "database",
  },
  session: {
    cookieCache: { enabled: false },
  },
  verification: {
    storeIdentifier: "hashed",
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    autoSignIn: false,
    minPasswordLength: 15,
    maxPasswordLength: 128,
    resetPasswordTokenExpiresIn: 1_800,
    revokeSessionsOnPasswordReset: true,
  },
  socialProviders: {
    google: { scopes: ["openid", "email", "profile"] },
    discord: { scopes: ["identify", "email"] },
  },
} as const;

type ExternalIdentityInput = {
  provider: "google" | "discord";
  issuer: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  linkedUserId: string | null;
  emailOwnerUserId: string | null;
};

export function canBeginExternalIdentityLink(input: {
  sessionUserId: string | null;
  primaryAuthenticatedAt: Date | null;
  now: Date;
  maximumAgeMs?: number;
}): boolean {
  if (!input.sessionUserId || !input.primaryAuthenticatedAt) return false;
  const age = input.now.getTime() - input.primaryAuthenticatedAt.getTime();
  return age >= 0 && age <= (input.maximumAgeMs ?? 15 * 60_000);
}

export function resolveExternalIdentitySignIn(input: ExternalIdentityInput):
  | { action: "sign_in"; userId: string; identityKey: string }
  | { action: "require_explicit_link"; existingUserId: string }
  | { action: "require_email_verification" }
  | { action: "create_user"; identityKey: string; verifiedEmail: string } {
  const identityKey = `${input.issuer}\0${input.subject}`;
  if (input.linkedUserId) return { action: "sign_in", userId: input.linkedUserId, identityKey };
  if (!input.email || !input.emailVerified) return { action: "require_email_verification" };
  if (input.emailOwnerUserId) {
    return { action: "require_explicit_link", existingUserId: input.emailOwnerUserId };
  }
  return { action: "create_user", identityKey, verifiedEmail: input.email };
}
