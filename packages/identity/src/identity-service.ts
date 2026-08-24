import { randomBytes, randomUUID } from "node:crypto";

import { and, eq, gt, isNull, sql } from "drizzle-orm";

import {
  identityAccounts,
  identityEmailAddresses,
  identitySessions,
  identityUsers,
  identityVerifications,
  insertOutboxEvent,
  type PawketDatabase,
} from "@pawket/database";
import { createLookupHmac, hashOpaqueToken, type EncryptionKeyring } from "@pawket/security";

import { hashPassword, verifyPassword } from "./auth-candidate/password.js";
import {
  canonicalizeEmailAddress,
  evaluatePassword,
  type CompromisedPasswordChecker,
} from "./core-identity-policy.js";
import { issueVerificationChallenge, revokeAllUserSessions } from "./identity-repository.js";
import { queueSecurityEmailHandoff } from "./security-email-handoff.js";

const publicAccepted = Object.freeze({ accepted: true } as const);

type IdentityServiceDependencies = {
  db: PawketDatabase;
  keyring: EncryptionKeyring;
  lookupHmacKey: Uint8Array;
  compromisedPasswordChecker: CompromisedPasswordChecker;
  idFactory?: () => string;
  tokenFactory?: (purpose: string) => string;
  now?: () => Date;
  passwordHasher?: (password: string) => Promise<string>;
  passwordVerifier?: (input: { hash: string; password: string }) => Promise<boolean>;
};

export class IdentityInputError extends Error {
  constructor(readonly reason: "password_policy" | "recent_authentication_required") {
    super("Identity request does not meet policy");
    this.name = "IdentityInputError";
  }
}

function defaultTokenFactory(): string {
  return randomBytes(32).toString("base64url");
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current && typeof current === "object" && "code" in current && current.code === "23505") {
      return true;
    }
    current = current && typeof current === "object" && "cause" in current
      ? current.cause
      : undefined;
  }
  return false;
}

export function createIdentityService(dependencies: IdentityServiceDependencies) {
  const idFactory = dependencies.idFactory ?? randomUUID;
  const tokenFactory = dependencies.tokenFactory ?? defaultTokenFactory;
  const currentTime = dependencies.now ?? (() => new Date());
  const passwordHasher = dependencies.passwordHasher ?? hashPassword;
  const passwordVerifier = dependencies.passwordVerifier ?? verifyPassword;

  const emailIdentifierHash = (canonicalEmail: string): string =>
    createLookupHmac({
      value: canonicalEmail,
      context: "email-address",
      key: dependencies.lookupHmacKey,
    });

  const assertPasswordAccepted = async (
    password: string,
    contextTerms: readonly string[] = [],
  ): Promise<void> => {
    const decision = await evaluatePassword({
      password,
      contextTerms,
      compromisedPasswordChecker: dependencies.compromisedPasswordChecker,
    });
    if (!decision.accepted) throw new IdentityInputError("password_policy");
  };

  const queueChallenge = async (
    tx: Parameters<Parameters<PawketDatabase["transaction"]>[0]>[0],
    input: {
      userId: string;
      email: string;
      canonicalEmail: string;
      purpose: "email_verification" | "password_reset" | "email_change";
      now: Date;
    },
  ): Promise<void> => {
    const token = tokenFactory(input.purpose);
    await issueVerificationChallenge(tx, {
      id: idFactory(),
      userId: input.userId,
      purpose: input.purpose,
      identifierHash: emailIdentifierHash(input.canonicalEmail),
      token,
      targetEmail: input.email,
      targetEmailCanonical: input.canonicalEmail,
      now: input.now,
      expiresAt: new Date(input.now.getTime() + 30 * 60_000),
    });
    await queueSecurityEmailHandoff(tx, {
      id: idFactory(),
      userId: input.userId,
      purpose: input.purpose,
      destination: input.email,
      secret: token,
      templateData: {
        returnPath:
          input.purpose === "password_reset" ? "/reset-password" : "/verify-email",
      },
      keyring: dependencies.keyring,
      now: input.now,
    });
  };

  return {
    async registerPassword(input: {
      name: string;
      email: string;
      password: string;
    }): Promise<{ accepted: true }> {
      const email = canonicalizeEmailAddress(input.email);
      await assertPasswordAccepted(input.password, ["pawket", email.canonical, input.name]);
      const passwordHash = await passwordHasher(input.password);
      const now = currentTime();

      try {
        await dependencies.db.transaction(async (tx) => {
          const existing = await tx
            .select({ id: identityUsers.id })
            .from(identityUsers)
            .where(eq(identityUsers.canonicalEmail, email.canonical))
            .limit(1);
          if (existing.length > 0) return;

          const userId = idFactory();
          await tx.insert(identityUsers).values({
            id: userId,
            name: input.name.trim().slice(0, 100),
            email: email.canonical,
            canonicalEmail: email.canonical,
            emailVerified: false,
            accessStatus: "active",
            authorizationVersion: 1,
            createdAt: now,
            updatedAt: now,
          });
          await tx.insert(identityAccounts).values({
            id: idFactory(),
            issuer: "local:credential",
            accountId: userId,
            providerId: "credential",
            userId,
            password: passwordHash,
            passwordHashVersion: 1,
            createdAt: now,
            updatedAt: now,
          });
          await tx.insert(identityEmailAddresses).values({
            id: idFactory(),
            userId,
            displayEmail: email.display,
            canonicalEmail: email.canonical,
            status: "primary",
            createdAt: now,
            updatedAt: now,
          });
          await queueChallenge(tx, {
            userId,
            email: email.display,
            canonicalEmail: email.canonical,
            purpose: "email_verification",
            now,
          });
          await insertOutboxEvent(tx, {
            eventType: "identity.user_registered.v1",
            eventVersion: 1,
            aggregateType: "identity_user",
            aggregateId: userId,
            payload: { userId, signInMethod: "password", emailState: "provisional" },
            occurredAt: now,
            availableAt: now,
          });
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
      return publicAccepted;
    },

    async resendEmailVerification(input: { email: string }): Promise<{ accepted: true }> {
      let email: ReturnType<typeof canonicalizeEmailAddress>;
      try {
        email = canonicalizeEmailAddress(input.email);
      } catch {
        return publicAccepted;
      }
      const [user] = await dependencies.db
        .select({
          id: identityUsers.id,
          email: identityUsers.email,
          canonicalEmail: identityUsers.canonicalEmail,
          emailVerified: identityUsers.emailVerified,
          accessStatus: identityUsers.accessStatus,
        })
        .from(identityUsers)
        .where(eq(identityUsers.canonicalEmail, email.canonical))
        .limit(1);
      if (!user || user.emailVerified || user.accessStatus !== "active") return publicAccepted;

      const now = currentTime();
      await dependencies.db.transaction(async (tx) => {
        await tx
          .update(identityVerifications)
          .set({ consumedAt: now, updatedAt: now })
          .where(
            and(
              eq(identityVerifications.userId, user.id),
              eq(identityVerifications.purpose, "email_verification"),
              isNull(identityVerifications.consumedAt),
            ),
          );
        await queueChallenge(tx, {
          userId: user.id,
          email: user.email,
          canonicalEmail: user.canonicalEmail,
          purpose: "email_verification",
          now,
        });
      });
      return publicAccepted;
    },

    async verifyEmail(input: { token: string }): Promise<{ verified: boolean }> {
      const now = currentTime();
      return dependencies.db.transaction(async (tx) => {
        const [challenge] = await tx
          .update(identityVerifications)
          .set({ consumedAt: now, updatedAt: now })
          .where(
            and(
              eq(identityVerifications.purpose, "email_verification"),
              eq(
                identityVerifications.value,
                hashOpaqueToken(input.token, "identity-email_verification"),
              ),
              isNull(identityVerifications.consumedAt),
              gt(identityVerifications.expiresAt, now),
            ),
          )
          .returning({ userId: identityVerifications.userId });
        if (!challenge?.userId) return { verified: false };

        const verified = await tx
          .update(identityUsers)
          .set({
            emailVerified: true,
            emailVerifiedAt: now,
            emailVerificationProvenance: "password_email_challenge",
            authorizationVersion: sql`${identityUsers.authorizationVersion} + 1`,
            updatedAt: now,
          })
          .where(and(eq(identityUsers.id, challenge.userId), eq(identityUsers.accessStatus, "active")))
          .returning({ id: identityUsers.id });
        if (verified.length !== 1) return { verified: false };

        await tx
          .update(identityEmailAddresses)
          .set({
            verifiedAt: now,
            verificationProvenance: "password_email_challenge",
            updatedAt: now,
          })
          .where(
            and(
              eq(identityEmailAddresses.userId, challenge.userId),
              eq(identityEmailAddresses.status, "primary"),
            ),
          );

        await tx
          .update(identityVerifications)
          .set({ consumedAt: now, updatedAt: now })
          .where(
            and(
              eq(identityVerifications.userId, challenge.userId),
              eq(identityVerifications.purpose, "email_verification"),
              isNull(identityVerifications.consumedAt),
            ),
          );
        await revokeAllUserSessions(tx, {
          userId: challenge.userId,
          reason: "email_verified_rotate",
          now,
        });
        await insertOutboxEvent(tx, {
          eventType: "identity.email_verified.v1",
          eventVersion: 1,
          aggregateType: "identity_user",
          aggregateId: challenge.userId,
          payload: { userId: challenge.userId, provenance: "password_email_challenge" },
          occurredAt: now,
          availableAt: now,
        });
        return { verified: true };
      });
    },

    async requestPasswordReset(input: { email: string }): Promise<{ accepted: true }> {
      // Always pay the configured password work factor before looking up the
      // account so known and unknown addresses have the same expensive step.
      await passwordHasher("pawket-enumeration-timing-pad");
      let email: ReturnType<typeof canonicalizeEmailAddress>;
      try {
        email = canonicalizeEmailAddress(input.email);
      } catch {
        return publicAccepted;
      }
      const [record] = await dependencies.db
        .select({
          userId: identityUsers.id,
          email: identityUsers.email,
          canonicalEmail: identityUsers.canonicalEmail,
        })
        .from(identityUsers)
        .innerJoin(
          identityAccounts,
          and(
            eq(identityAccounts.userId, identityUsers.id),
            eq(identityAccounts.providerId, "credential"),
          ),
        )
        .where(
          and(
            eq(identityUsers.canonicalEmail, email.canonical),
            eq(identityUsers.emailVerified, true),
            eq(identityUsers.accessStatus, "active"),
            sql`${identityAccounts.password} is not null`,
          ),
        )
        .limit(1);
      if (!record) return publicAccepted;

      const now = currentTime();
      await dependencies.db.transaction((tx) =>
        queueChallenge(tx, {
          userId: record.userId,
          email: record.email,
          canonicalEmail: record.canonicalEmail,
          purpose: "password_reset",
          now,
        }),
      );
      return publicAccepted;
    },

    async resetPassword(input: {
      token: string;
      newPassword: string;
    }): Promise<{ completed: boolean }> {
      await assertPasswordAccepted(input.newPassword, ["pawket"]);
      const newPasswordHash = await passwordHasher(input.newPassword);
      const now = currentTime();
      return dependencies.db.transaction(async (tx) => {
        const [challenge] = await tx
          .update(identityVerifications)
          .set({ consumedAt: now, updatedAt: now })
          .where(
            and(
              eq(identityVerifications.purpose, "password_reset"),
              eq(
                identityVerifications.value,
                hashOpaqueToken(input.token, "identity-password_reset"),
              ),
              isNull(identityVerifications.consumedAt),
              gt(identityVerifications.expiresAt, now),
            ),
          )
          .returning({ userId: identityVerifications.userId });
        if (!challenge?.userId) return { completed: false };

        const credential = await tx
          .update(identityAccounts)
          .set({ password: newPasswordHash, passwordHashVersion: 1, updatedAt: now })
          .where(
            and(
              eq(identityAccounts.userId, challenge.userId),
              eq(identityAccounts.providerId, "credential"),
              sql`${identityAccounts.password} is not null`,
            ),
          )
          .returning({ id: identityAccounts.id });
        if (credential.length !== 1) return { completed: false };

        const [user] = await tx
          .update(identityUsers)
          .set({
            authorizationVersion: sql`${identityUsers.authorizationVersion} + 1`,
            updatedAt: now,
          })
          .where(and(eq(identityUsers.id, challenge.userId), eq(identityUsers.accessStatus, "active")))
          .returning({ id: identityUsers.id, email: identityUsers.email });
        if (!user) return { completed: false };

        await tx
          .update(identityVerifications)
          .set({ consumedAt: now, updatedAt: now })
          .where(
            and(
              eq(identityVerifications.userId, challenge.userId),
              eq(identityVerifications.purpose, "password_reset"),
              isNull(identityVerifications.consumedAt),
            ),
          );
        await revokeAllUserSessions(tx, {
          userId: challenge.userId,
          reason: "password_reset",
          now,
        });
        await queueSecurityEmailHandoff(tx, {
          id: idFactory(),
          userId: challenge.userId,
          purpose: "security_notice",
          destination: user.email,
          templateData: { event: "password_changed" },
          keyring: dependencies.keyring,
          now,
        });
        await insertOutboxEvent(tx, {
          eventType: "identity.password_changed.v1",
          eventVersion: 1,
          aggregateType: "identity_user",
          aggregateId: challenge.userId,
          payload: { userId: challenge.userId, method: "password_reset" },
          occurredAt: now,
          availableAt: now,
        });
        return { completed: true };
      });
    },

    async changePassword(input: {
      userId: string;
      currentPassword: string;
      newPassword: string;
      currentSessionId: string;
      primaryAuthenticatedAt: Date;
    }): Promise<{ changed: boolean }> {
      const now = currentTime();
      if (
        now.getTime() - input.primaryAuthenticatedAt.getTime() < 0 ||
        now.getTime() - input.primaryAuthenticatedAt.getTime() > 15 * 60_000
      ) {
        throw new IdentityInputError("recent_authentication_required");
      }
      const [credential] = await dependencies.db
        .select({ hash: identityAccounts.password })
        .from(identityAccounts)
        .where(
          and(
            eq(identityAccounts.userId, input.userId),
            eq(identityAccounts.providerId, "credential"),
          ),
        )
        .limit(1);
      if (!credential?.hash || !(await passwordVerifier({ hash: credential.hash, password: input.currentPassword }))) {
        return { changed: false };
      }
      await assertPasswordAccepted(input.newPassword, ["pawket"]);
      const passwordHash = await passwordHasher(input.newPassword);
      await dependencies.db.transaction(async (tx) => {
        await tx
          .update(identityAccounts)
          .set({ password: passwordHash, passwordHashVersion: 1, updatedAt: now })
          .where(
            and(
              eq(identityAccounts.userId, input.userId),
              eq(identityAccounts.providerId, "credential"),
            ),
          );
        await revokeAllUserSessions(tx, {
          userId: input.userId,
          reason: "password_changed",
          exceptSessionId: input.currentSessionId,
          now,
        });
        const [user] = await tx
          .select({ email: identityUsers.email })
          .from(identityUsers)
          .where(eq(identityUsers.id, input.userId))
          .limit(1);
        if (!user) throw new Error("Identity password change failed");
        await queueSecurityEmailHandoff(tx, {
          id: idFactory(),
          userId: input.userId,
          purpose: "security_notice",
          destination: user.email,
          templateData: { event: "password_changed" },
          keyring: dependencies.keyring,
          now,
        });
        await insertOutboxEvent(tx, {
          eventType: "identity.password_changed.v1",
          eventVersion: 1,
          aggregateType: "identity_user",
          aggregateId: input.userId,
          payload: { userId: input.userId, method: "authenticated_change" },
          occurredAt: now,
          availableAt: now,
        });
      });
      return { changed: true };
    },

    async requestEmailChange(input: {
      userId: string;
      newEmail: string;
      primaryAuthenticatedAt: Date;
    }): Promise<{ accepted: boolean }> {
      const now = currentTime();
      const primaryAge = now.getTime() - input.primaryAuthenticatedAt.getTime();
      if (primaryAge < 0 || primaryAge > 15 * 60_000) {
        throw new IdentityInputError("recent_authentication_required");
      }
      const target = canonicalizeEmailAddress(input.newEmail);
      const [user] = await dependencies.db
        .select({
          id: identityUsers.id,
          canonicalEmail: identityUsers.canonicalEmail,
          emailVerified: identityUsers.emailVerified,
          accessStatus: identityUsers.accessStatus,
        })
        .from(identityUsers)
        .where(eq(identityUsers.id, input.userId))
        .limit(1);
      if (
        !user ||
        !user.emailVerified ||
        user.accessStatus !== "active" ||
        user.canonicalEmail === target.canonical
      ) {
        return { accepted: false };
      }

      try {
        return await dependencies.db.transaction(async (tx) => {
          const reserved = await tx
            .select({ id: identityEmailAddresses.id })
            .from(identityEmailAddresses)
            .where(eq(identityEmailAddresses.canonicalEmail, target.canonical))
            .limit(1);
          if (reserved.length > 0) return { accepted: false };

          await tx
            .update(identityVerifications)
            .set({ consumedAt: now, updatedAt: now })
            .where(
              and(
                eq(identityVerifications.userId, input.userId),
                eq(identityVerifications.purpose, "email_change"),
                isNull(identityVerifications.consumedAt),
              ),
            );
          await tx
            .delete(identityEmailAddresses)
            .where(
              and(
                eq(identityEmailAddresses.userId, input.userId),
                eq(identityEmailAddresses.status, "pending"),
              ),
            );
          await tx.insert(identityEmailAddresses).values({
            id: idFactory(),
            userId: input.userId,
            displayEmail: target.display,
            canonicalEmail: target.canonical,
            status: "pending",
            createdAt: now,
            updatedAt: now,
          });
          await queueChallenge(tx, {
            userId: input.userId,
            email: target.display,
            canonicalEmail: target.canonical,
            purpose: "email_change",
            now,
          });
          return { accepted: true };
        });
      } catch (error) {
        if (isUniqueViolation(error)) return { accepted: false };
        throw error;
      }
    },

    async completeEmailChange(input: {
      userId: string;
      token: string;
      currentSessionId: string;
    }): Promise<{ completed: boolean }> {
      const now = currentTime();
      return dependencies.db.transaction(async (tx) => {
        const [challenge] = await tx
          .update(identityVerifications)
          .set({ consumedAt: now, updatedAt: now })
          .where(
            and(
              eq(identityVerifications.purpose, "email_change"),
              eq(identityVerifications.userId, input.userId),
              eq(
                identityVerifications.value,
                hashOpaqueToken(input.token, "identity-email_change"),
              ),
              isNull(identityVerifications.consumedAt),
              gt(identityVerifications.expiresAt, now),
            ),
          )
          .returning({
            userId: identityVerifications.userId,
            targetEmail: identityVerifications.targetEmail,
            targetEmailCanonical: identityVerifications.targetEmailCanonical,
          });
        if (
          challenge?.userId !== input.userId ||
          !challenge.targetEmail ||
          !challenge.targetEmailCanonical
        ) {
          return { completed: false };
        }

        const [user] = await tx
          .select({ email: identityUsers.email })
          .from(identityUsers)
          .where(
            and(
              eq(identityUsers.id, input.userId),
              eq(identityUsers.accessStatus, "active"),
              eq(identityUsers.emailVerified, true),
            ),
          )
          .limit(1)
          .for("update");
        const [pending] = await tx
          .select({ id: identityEmailAddresses.id })
          .from(identityEmailAddresses)
          .where(
            and(
              eq(identityEmailAddresses.userId, input.userId),
              eq(identityEmailAddresses.canonicalEmail, challenge.targetEmailCanonical),
              eq(identityEmailAddresses.status, "pending"),
            ),
          )
          .limit(1)
          .for("update");
        if (!user || !pending) return { completed: false };

        await tx
          .update(identityEmailAddresses)
          .set({ status: "previous", replacedAt: now, updatedAt: now })
          .where(
            and(
              eq(identityEmailAddresses.userId, input.userId),
              eq(identityEmailAddresses.status, "primary"),
            ),
          );
        await tx
          .update(identityEmailAddresses)
          .set({
            status: "primary",
            verifiedAt: now,
            verificationProvenance: "password_email_challenge",
            updatedAt: now,
          })
          .where(eq(identityEmailAddresses.id, pending.id));
        const [updatedUser] = await tx
          .update(identityUsers)
          .set({
            email: challenge.targetEmailCanonical,
            canonicalEmail: challenge.targetEmailCanonical,
            emailVerified: true,
            emailVerifiedAt: now,
            emailVerificationProvenance: "password_email_challenge",
            authorizationVersion: sql`${identityUsers.authorizationVersion} + 1`,
            updatedAt: now,
          })
          .where(eq(identityUsers.id, input.userId))
          .returning({ authorizationVersion: identityUsers.authorizationVersion });
        if (!updatedUser) return { completed: false };

        await tx
          .update(identitySessions)
          .set({
            authorizationVersion: updatedUser.authorizationVersion,
            updatedAt: now,
          })
          .where(
            and(
              eq(identitySessions.id, input.currentSessionId),
              eq(identitySessions.userId, input.userId),
              isNull(identitySessions.revokedAt),
            ),
          );
        await revokeAllUserSessions(tx, {
          userId: input.userId,
          reason: "primary_email_changed",
          exceptSessionId: input.currentSessionId,
          now,
        });
        await tx
          .update(identityVerifications)
          .set({ consumedAt: now, updatedAt: now })
          .where(
            and(
              eq(identityVerifications.userId, input.userId),
              eq(identityVerifications.purpose, "email_change"),
              isNull(identityVerifications.consumedAt),
            ),
          );
        await queueSecurityEmailHandoff(tx, {
          id: idFactory(),
          userId: input.userId,
          purpose: "security_notice",
          destination: user.email,
          templateData: { event: "primary_email_changed" },
          keyring: dependencies.keyring,
          now,
        });
        await insertOutboxEvent(tx, {
          eventType: "identity.primary_email_changed.v1",
          eventVersion: 1,
          aggregateType: "identity_user",
          aggregateId: input.userId,
          payload: { userId: input.userId, addressChange: "completed" },
          occurredAt: now,
          availableAt: now,
        });
        return { completed: true };
      });
    },

    async setUserAccessStatus(input: {
      userId: string;
      status: "active" | "access_suspended" | "closed";
      now?: Date;
    }): Promise<boolean> {
      const now = input.now ?? currentTime();
      return dependencies.db.transaction(async (tx) => {
        const [current] = await tx
          .select({ status: identityUsers.accessStatus })
          .from(identityUsers)
          .where(eq(identityUsers.id, input.userId))
          .limit(1)
          .for("update");
        if (!current) return false;
        if (current.status === input.status) return true;
        await tx
          .update(identityUsers)
          .set({
            accessStatus: input.status,
            authorizationVersion: sql`${identityUsers.authorizationVersion} + 1`,
            updatedAt: now,
          })
          .where(eq(identityUsers.id, input.userId));
        if (input.status !== "active") {
          await revokeAllUserSessions(tx, {
            userId: input.userId,
            reason: input.status,
            now,
          });
        }
        await insertOutboxEvent(tx, {
          eventType: "identity.user_access_changed.v1",
          eventVersion: 1,
          aggregateType: "identity_user",
          aggregateId: input.userId,
          payload: { userId: input.userId, accessStatus: input.status },
          occurredAt: now,
          availableAt: now,
        });
        return true;
      });
    },
  };
}
