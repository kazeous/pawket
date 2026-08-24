import { randomUUID } from "node:crypto";

import { and, eq, isNull, sql } from "drizzle-orm";

import {
  appendAdminAuditEvent,
  identityRoleGrants,
  identitySessions,
  identityUsers,
  type PawketDatabase,
} from "@pawket/database";
import { canonicalizeEmailAddress, queueSecurityEmailHandoff } from "@pawket/identity";
import type { EncryptionKeyring } from "@pawket/security";

const bootstrapIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

export type OwnerBootstrapErrorCode =
  | "CONFIRMATION_REQUIRED"
  | "INVALID_BOOTSTRAP_INPUT"
  | "OWNER_ACCOUNT_INELIGIBLE"
  | "OWNER_ALREADY_EXISTS"
  | "OWNER_EMAIL_MISMATCH"
  | "REVISION_MISMATCH";

export class OwnerBootstrapError extends Error {
  constructor(readonly code: OwnerBootstrapErrorCode) {
    super(code);
    this.name = "OwnerBootstrapError";
  }
}

export function ownerBootstrapConfirmation(userId: string): string {
  return `BOOTSTRAP_OWNER:${userId}`;
}

function assertOperationalIdentifier(value: string): void {
  if (!bootstrapIdentifierPattern.test(value)) {
    throw new OwnerBootstrapError("INVALID_BOOTSTRAP_INPUT");
  }
}

function isUniqueViolation(error: unknown): boolean {
  let candidate: unknown = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!candidate || typeof candidate !== "object") return false;
    if ("code" in candidate && candidate.code === "23505") return true;
    candidate = "cause" in candidate ? candidate.cause : undefined;
  }
  return false;
}

export async function bootstrapOwner(
  db: PawketDatabase,
  input: {
    userId: string;
    configuredEmail: string;
    confirmation: string;
    applicationRevision: string;
    confirmedApplicationRevision: string;
    requestId: string;
    keyring: EncryptionKeyring;
    now: Date;
  },
): Promise<{
  userId: string;
  roleGrantId: string;
  authorizationVersion: number;
  revokedSessionCount: number;
}> {
  assertOperationalIdentifier(input.userId);
  assertOperationalIdentifier(input.applicationRevision);
  assertOperationalIdentifier(input.confirmedApplicationRevision);
  assertOperationalIdentifier(input.requestId);
  if (Number.isNaN(input.now.getTime())) {
    throw new OwnerBootstrapError("INVALID_BOOTSTRAP_INPUT");
  }
  if (input.confirmation !== ownerBootstrapConfirmation(input.userId)) {
    throw new OwnerBootstrapError("CONFIRMATION_REQUIRED");
  }
  if (input.confirmedApplicationRevision !== input.applicationRevision) {
    throw new OwnerBootstrapError("REVISION_MISMATCH");
  }

  let configuredCanonical: string;
  try {
    configuredCanonical = canonicalizeEmailAddress(input.configuredEmail).canonical;
  } catch {
    throw new OwnerBootstrapError("INVALID_BOOTSTRAP_INPUT");
  }

  try {
    return await db.transaction(async (tx) => {
      const [target] = await tx
        .select({
          id: identityUsers.id,
          email: identityUsers.email,
          canonicalEmail: identityUsers.canonicalEmail,
          emailVerified: identityUsers.emailVerified,
          accessStatus: identityUsers.accessStatus,
          authorizationVersion: identityUsers.authorizationVersion,
        })
        .from(identityUsers)
        .where(eq(identityUsers.id, input.userId))
        .limit(1)
        .for("update");

      if (!target || target.accessStatus !== "active" || !target.emailVerified) {
        throw new OwnerBootstrapError("OWNER_ACCOUNT_INELIGIBLE");
      }
      if (target.canonicalEmail !== configuredCanonical) {
        throw new OwnerBootstrapError("OWNER_EMAIL_MISMATCH");
      }

      const [existingOwner] = await tx
        .select({ id: identityRoleGrants.id })
        .from(identityRoleGrants)
        .where(eq(identityRoleGrants.role, "owner"))
        .limit(1);
      if (existingOwner) throw new OwnerBootstrapError("OWNER_ALREADY_EXISTS");

      const [grant] = await tx
        .insert(identityRoleGrants)
        .values({
          userId: target.id,
          role: "owner",
          state: "active",
          grantSource: "bootstrap_cli",
          grantedByUserId: null,
          version: 1,
          grantedAt: input.now,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning({ id: identityRoleGrants.id });
      if (!grant) throw new Error("Owner role grant was not created");

      const [updatedUser] = await tx
        .update(identityUsers)
        .set({
          authorizationVersion: sql`${identityUsers.authorizationVersion} + 1`,
          updatedAt: input.now,
        })
        .where(eq(identityUsers.id, target.id))
        .returning({ authorizationVersion: identityUsers.authorizationVersion });
      if (!updatedUser) throw new Error("Owner account was not updated");

      const revokedSessions = await tx
        .update(identitySessions)
        .set({
          revokedAt: input.now,
          revocationReason: "owner_bootstrap",
          updatedAt: input.now,
        })
        .where(
          and(
            eq(identitySessions.userId, target.id),
            isNull(identitySessions.revokedAt),
          ),
        )
        .returning({ id: identitySessions.id });

      await appendAdminAuditEvent(tx, {
        actorUserId: target.id,
        actorSessionId: null,
        subjectType: "identity_user",
        subjectId: target.id,
        action: "identity.owner_bootstrapped",
        outcome: "succeeded",
        reasonCode: "bootstrap_cli",
        beforeState: {
          accessRevision: target.authorizationVersion,
          owner: false,
        },
        afterState: {
          accessRevision: updatedUser.authorizationVersion,
          owner: true,
          sessionsRevoked: revokedSessions.length,
        },
        assurance: {
          method: "operational_cli",
          confirmation: "exact_user_bound",
          adminAccess: "requires_new_totp_session",
        },
        applicationRevision: input.applicationRevision,
        requestId: input.requestId,
        occurredAt: input.now,
      });

      await queueSecurityEmailHandoff(tx, {
        id: randomUUID(),
        userId: target.id,
        purpose: "security_notice",
        destination: target.email,
        templateData: {
          event: "owner_bootstrap_completed",
          returnPath: "/settings/security",
        },
        keyring: input.keyring,
        now: input.now,
      });

      return {
        userId: target.id,
        roleGrantId: grant.id,
        authorizationVersion: updatedUser.authorizationVersion,
        revokedSessionCount: revokedSessions.length,
      };
    });
  } catch (error) {
    if (error instanceof OwnerBootstrapError) throw error;
    if (isUniqueViolation(error)) throw new OwnerBootstrapError("OWNER_ALREADY_EXISTS");
    throw error;
  }
}
