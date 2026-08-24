import { randomUUID } from "node:crypto";

import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { expireCookie, setSessionCookie } from "better-auth/cookies";
import * as z from "zod";

import {
  identityRoleGrants,
  identitySessions,
  identityTotpAuthenticators,
  identityUsers,
  type PawketDatabase,
} from "@pawket/database";
import type { EncryptionKeyring } from "@pawket/security";

import {
  consumeRecoveryCode,
  createRecoveryCodeBatchInTransaction,
  recoveryCodeAvailable,
} from "./identity-security-repository.js";
import { queueSecurityEmailHandoff } from "./security-email-handoff.js";

const recoveryBody = z.object({
  code: z.string().min(10).max(64),
});

const invalidRecoveryCode = {
  message: "Recovery code could not be verified",
  code: "INVALID_RECOVERY_CODE",
};

export function pawketRecoveryCodePlugin(options: {
  db: PawketDatabase;
  keyring: EncryptionKeyring;
}) {
  return {
    id: "pawket-recovery-code",
    endpoints: {
      regeneratePawketRecoveryCodes: createAuthEndpoint(
        "/two-factor/regenerate-recovery-codes",
        { method: "POST", body: z.object({}), use: [sessionMiddleware] },
        async (ctx) => {
          const now = new Date();
          const user = ctx.context.session.user;
          const session = ctx.context.session.session;
          const [recentTotp] = await options.db
            .select({ id: identitySessions.id })
            .from(identitySessions)
            .where(
              and(
                eq(identitySessions.id, session.id),
                eq(identitySessions.userId, user.id),
                eq(identitySessions.assuranceState, "active"),
                isNull(identitySessions.revokedAt),
                gt(identitySessions.expiresAt, now),
                gt(identitySessions.mfaVerifiedAt, new Date(now.getTime() - 5 * 60_000)),
              ),
            )
            .limit(1);
          if (!recentTotp) {
            throw APIError.from("UNAUTHORIZED", {
              message: "Recent TOTP authentication is required",
              code: "RECENT_TOTP_REQUIRED",
            });
          }
          const [authenticator] = await options.db
            .select({ id: identityTotpAuthenticators.id })
            .from(identityTotpAuthenticators)
            .where(
              and(
                eq(identityTotpAuthenticators.userId, user.id),
                eq(identityTotpAuthenticators.verified, true),
              ),
            )
            .limit(1);
          if (!authenticator) throw APIError.from("UNAUTHORIZED", invalidRecoveryCode);
          const recovery = await options.db.transaction(async (tx) => {
            const created = await createRecoveryCodeBatchInTransaction(tx, {
              authenticatorId: authenticator.id,
              now,
            });
            await queueSecurityEmailHandoff(tx, {
              id: randomUUID(),
              userId: user.id,
              purpose: "security_notice",
              destination: user.email,
              templateData: {
                event: "recovery_codes_regenerated",
                returnPath: "/settings/security",
              },
              keyring: options.keyring,
              now,
            });
            return created;
          });
          return ctx.json({ recoveryCodes: recovery.codes });
        },
      ),
      verifyPawketRecoveryCode: createAuthEndpoint(
        "/two-factor/verify-recovery-code",
        { method: "POST", body: recoveryBody },
        async (ctx) => {
          const twoFactorCookie = ctx.context.createAuthCookie("two_factor", { maxAge: 600 });
          const challengeIdentifier = await ctx.getSignedCookie(
            twoFactorCookie.name,
            ctx.context.secret,
          );
          if (!challengeIdentifier) {
            throw APIError.from("UNAUTHORIZED", invalidRecoveryCode);
          }
          const challenge = await ctx.context.internalAdapter.findVerificationValue(
            challengeIdentifier,
          );
          if (!challenge || challenge.expiresAt <= new Date()) {
            expireCookie(ctx, twoFactorCookie);
            throw APIError.from("UNAUTHORIZED", invalidRecoveryCode);
          }
          const user = await ctx.context.internalAdapter.findUserById(challenge.value);
          if (!user) throw APIError.from("UNAUTHORIZED", invalidRecoveryCode);

          const attemptsIdentifier = `2fa-attempts-${challengeIdentifier}`;
          const attemptRecord = await ctx.context.internalAdapter
            .consumeVerificationValue(attemptsIdentifier)
            .catch(() => null);
          if (!attemptRecord) throw APIError.from("UNAUTHORIZED", invalidRecoveryCode);
          const parsedAttempts = Number(attemptRecord.value);
          const attempts = Number.isInteger(parsedAttempts) && parsedAttempts >= 0
            ? parsedAttempts
            : 5;
          if (attempts >= 5) {
            await ctx.context.internalAdapter
              .consumeVerificationValue(challengeIdentifier)
              .catch(() => null);
            expireCookie(ctx, twoFactorCookie);
            throw APIError.from("UNAUTHORIZED", invalidRecoveryCode);
          }
          const recordFailure = () =>
            ctx.context.internalAdapter.createVerificationValue({
              value: `${attempts + 1}`,
              identifier: attemptsIdentifier,
              expiresAt: challenge.expiresAt,
            });

          const [owner] = await options.db
            .select({ id: identityRoleGrants.id })
            .from(identityRoleGrants)
            .where(
              and(
                eq(identityRoleGrants.userId, user.id),
                eq(identityRoleGrants.role, "owner"),
                eq(identityRoleGrants.state, "active"),
              ),
            )
            .limit(1);
          if (owner) {
            await ctx.context.internalAdapter
              .consumeVerificationValue(challengeIdentifier)
              .catch(() => null);
            expireCookie(ctx, twoFactorCookie);
            throw APIError.from("UNAUTHORIZED", invalidRecoveryCode);
          }

          const [authenticator] = await options.db
            .select({ id: identityTotpAuthenticators.id })
            .from(identityTotpAuthenticators)
            .where(
              and(
                eq(identityTotpAuthenticators.userId, user.id),
                eq(identityTotpAuthenticators.verified, true),
              ),
            )
            .limit(1);
          if (!authenticator) {
            await recordFailure();
            throw APIError.from("UNAUTHORIZED", invalidRecoveryCode);
          }
          if (
            !(await recoveryCodeAvailable(options.db, {
              authenticatorId: authenticator.id,
              code: ctx.body.code,
            }))
          ) {
            await recordFailure();
            throw APIError.from("UNAUTHORIZED", invalidRecoveryCode);
          }

          const consumedChallenge = await ctx.context.internalAdapter.consumeVerificationValue(
            challengeIdentifier,
          );
          if (!consumedChallenge || consumedChallenge.value !== user.id) {
            expireCookie(ctx, twoFactorCookie);
            throw APIError.from("UNAUTHORIZED", invalidRecoveryCode);
          }

          const now = new Date();
          await options.db.transaction(async (tx) => {
            const consumedCode = await consumeRecoveryCode(tx, {
              authenticatorId: authenticator.id,
              code: ctx.body.code,
              now,
            });
            if (!consumedCode) throw APIError.from("UNAUTHORIZED", invalidRecoveryCode);

            await tx
              .delete(identityTotpAuthenticators)
              .where(
                and(
                  eq(identityTotpAuthenticators.id, authenticator.id),
                  eq(identityTotpAuthenticators.userId, user.id),
                ),
              );
            const [updatedUser] = await tx
              .update(identityUsers)
              .set({
                twoFactorEnabled: false,
                authorizationVersion: sql`${identityUsers.authorizationVersion} + 1`,
                updatedAt: now,
              })
              .where(eq(identityUsers.id, user.id))
              .returning({ id: identityUsers.id });
            if (!updatedUser) throw new Error("Recovery user is unavailable");
            await tx
              .update(identitySessions)
              .set({
                revokedAt: now,
                revocationReason: "recovery_code_factor_reset",
                updatedAt: now,
              })
              .where(
                and(
                  eq(identitySessions.userId, user.id),
                  isNull(identitySessions.revokedAt),
                ),
              );
            await queueSecurityEmailHandoff(tx, {
              id: randomUUID(),
              userId: user.id,
              purpose: "security_notice",
              destination: user.email,
              templateData: {
                event: "recovery_code_used_factor_reset_required",
                returnPath: "/settings/security",
              },
              keyring: options.keyring,
              now,
            });
          });

          const session = await ctx.context.internalAdapter.createSession(user.id, false);
          if (!session) {
            throw APIError.from("INTERNAL_SERVER_ERROR", {
              message: "Recovery session could not be created",
              code: "RECOVERY_SESSION_FAILED",
            });
          }
          await setSessionCookie(ctx, { session, user });
          expireCookie(ctx, twoFactorCookie);
          return ctx.json({
            token: session.token,
            user: {
              id: user.id,
              name: user.name,
              email: user.email,
              emailVerified: user.emailVerified,
              image: user.image,
            },
            requiresTotpRecovery: true,
          });
        },
      ),
    },
  };
}
