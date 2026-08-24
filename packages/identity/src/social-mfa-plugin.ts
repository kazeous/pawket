import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";
import { generateRandomString } from "better-auth/crypto";
import * as z from "zod";

export function socialMfaChallengePlugin() {
  return {
    id: "pawket-social-mfa-challenge",
    endpoints: {
      beginSocialMfaChallenge: createAuthEndpoint.serverOnly(
        { method: "POST", body: z.object({}), use: [sessionMiddleware] },
        async (context) => {
          const authenticated = context.context.session;
          if (!authenticated.user.twoFactorEnabled) {
            return context.json({ challenged: false });
          }

          const maxAge = 600;
          const challengeCookie = context.context.createAuthCookie("two_factor", { maxAge });
          const identifier = `2fa-${generateRandomString(20)}`;
          const expiresAt = new Date(Date.now() + maxAge * 1_000);
          await context.context.internalAdapter.createVerificationValue({
            value: authenticated.user.id,
            identifier,
            expiresAt,
          });
          await context.context.internalAdapter.createVerificationValue({
            value: "0",
            identifier: `2fa-attempts-${identifier}`,
            expiresAt,
          });
          await context.context.internalAdapter.deleteSession(authenticated.session.token);
          deleteSessionCookie(context, true);
          await context.setSignedCookie(
            challengeCookie.name,
            identifier,
            context.context.secret,
            challengeCookie.attributes,
          );
          return context.json({ challenged: true });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
