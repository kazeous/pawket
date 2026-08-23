import { describe, expect, test } from "vitest";

import {
  canBeginExternalIdentityLink,
  candidateAuthPolicy,
  resolveExternalIdentitySignIn,
} from "../../src/auth-candidate/identity-policy.js";

describe("external identity and candidate configuration", () => {
  test("pins safe account-linking, verification, session, and provider settings", () => {
    expect(candidateAuthPolicy.account.accountLinking).toEqual({
      enabled: true,
      disableImplicitLinking: true,
      allowDifferentEmails: false,
    });
    expect(candidateAuthPolicy.session.cookieCache.enabled).toBe(false);
    expect(candidateAuthPolicy.verification.storeIdentifier).toBe("hashed");
    expect(candidateAuthPolicy.emailAndPassword).toEqual(
      expect.objectContaining({
        requireEmailVerification: true,
        autoSignIn: false,
        minPasswordLength: 15,
        maxPasswordLength: 128,
        resetPasswordTokenExpiresIn: 1_800,
        revokeSessionsOnPasswordReset: true,
      }),
    );
    expect(candidateAuthPolicy.socialProviders.google.scopes).toEqual(["openid", "email", "profile"]);
    expect(candidateAuthPolicy.socialProviders.discord.scopes).toEqual(["identify", "email"]);
  });

  test("uses provider issuer and subject, never email, as the external identity key", () => {
    expect(
      resolveExternalIdentitySignIn({
        provider: "google",
        issuer: "https://accounts.google.com",
        subject: "google-sub-123",
        email: "artist@example.com",
        emailVerified: true,
        linkedUserId: "user-1",
        emailOwnerUserId: "user-2",
      }),
    ).toEqual({ action: "sign_in", userId: "user-1", identityKey: "https://accounts.google.com\0google-sub-123" });
  });

  test("requires explicit authenticated linking on same-email collision", () => {
    expect(
      resolveExternalIdentitySignIn({
        provider: "discord",
        issuer: "https://discord.com",
        subject: "discord-user-22",
        email: "artist@example.com",
        emailVerified: true,
        linkedUserId: null,
        emailOwnerUserId: "existing-user",
      }),
    ).toEqual({ action: "require_explicit_link", existingUserId: "existing-user" });
  });

  test("starts explicit linking only from a recent authenticated session", () => {
    const now = new Date("2026-08-24T01:00:00.000Z");
    expect(
      canBeginExternalIdentityLink({
        sessionUserId: "existing-user",
        primaryAuthenticatedAt: new Date("2026-08-24T00:50:00.000Z"),
        now,
      }),
    ).toBe(true);
    expect(
      canBeginExternalIdentityLink({
        sessionUserId: "existing-user",
        primaryAuthenticatedAt: new Date("2026-08-24T00:44:59.999Z"),
        now,
      }),
    ).toBe(false);
    expect(
      canBeginExternalIdentityLink({
        sessionUserId: null,
        primaryAuthenticatedAt: new Date("2026-08-24T00:59:00.000Z"),
        now,
      }),
    ).toBe(false);
  });

  test("requires Pawket email verification when provider email is absent or unverified", () => {
    for (const email of [null, "artist@example.com"] as const) {
      expect(
        resolveExternalIdentitySignIn({
          provider: "discord",
          issuer: "https://discord.com",
          subject: "discord-user-23",
          email,
          emailVerified: false,
          linkedUserId: null,
          emailOwnerUserId: null,
        }),
      ).toEqual({ action: "require_email_verification" });
    }
  });
});
