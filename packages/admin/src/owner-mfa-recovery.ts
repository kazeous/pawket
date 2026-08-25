import { randomUUID } from "node:crypto";

import { and, eq, isNull, sql } from "drizzle-orm";

import {
  appendAdminAuditEvent,
  beginIdempotentCommand,
  completeIdempotentCommand,
  identityRoleGrants,
  identitySessions,
  identityTotpAuthenticators,
  identityUsers,
  type PawketDatabase,
} from "@pawket/database";
import { canonicalizeEmailAddress, queueSecurityEmailHandoff } from "@pawket/identity";
import { hashOpaqueToken, type EncryptionKeyring } from "@pawket/security";

const operationalIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const WAIT_MS = 24 * 60 * 60 * 1_000;

export type OwnerMfaRecoveryErrorCode =
  | "CONFIRMATION_REQUIRED"
  | "EVIDENCE_REQUIRED"
  | "INVALID_RECOVERY_INPUT"
  | "OWNER_EMAIL_MISMATCH"
  | "OWNER_STATE_INVALID"
  | "RECOVERY_ALREADY_USED"
  | "WAIT_PERIOD_REQUIRED";

export class OwnerMfaRecoveryError extends Error {
  constructor(readonly code: OwnerMfaRecoveryErrorCode) {
    super(code);
    this.name = "OwnerMfaRecoveryError";
  }
}

export function ownerMfaRecoveryConfirmation(userId: string, incidentId: string): string {
  return `RECOVER_OWNER_MFA:${userId}:${incidentId}`;
}

function assertIdentifier(value: string): void {
  if (!operationalIdentifierPattern.test(value)) {
    throw new OwnerMfaRecoveryError("INVALID_RECOVERY_INPUT");
  }
}

export async function recoverOwnerMfa(
  db: PawketDatabase,
  input: {
    userId: string;
    configuredEmail: string;
    incidentId: string;
    repositoryEvidenceId: string;
    hostEvidenceId: string;
    authorizedAt: Date;
    emergencyReason?: "active_refund_deadline";
    confirmation: string;
    applicationRevision: string;
    keyring: EncryptionKeyring;
    now: Date;
  },
): Promise<{
  userId: string;
  authorizationVersion: number;
  revokedSessionCount: number;
  invalidatedAuthenticatorCount: number;
}> {
  for (const identifier of [
    input.userId,
    input.incidentId,
    input.repositoryEvidenceId,
    input.hostEvidenceId,
    input.applicationRevision,
  ]) {
    assertIdentifier(identifier);
  }
  if (
    Number.isNaN(input.now.getTime()) ||
    Number.isNaN(input.authorizedAt.getTime()) ||
    input.authorizedAt > input.now ||
    (input.emergencyReason !== undefined && input.emergencyReason !== "active_refund_deadline")
  ) {
    throw new OwnerMfaRecoveryError("INVALID_RECOVERY_INPUT");
  }
  if (input.repositoryEvidenceId === input.hostEvidenceId) {
    throw new OwnerMfaRecoveryError("EVIDENCE_REQUIRED");
  }
  if (input.confirmation !== ownerMfaRecoveryConfirmation(input.userId, input.incidentId)) {
    throw new OwnerMfaRecoveryError("CONFIRMATION_REQUIRED");
  }
  if (input.now.getTime() - input.authorizedAt.getTime() < WAIT_MS && !input.emergencyReason) {
    throw new OwnerMfaRecoveryError("WAIT_PERIOD_REQUIRED");
  }

  let configuredCanonical: string;
  try {
    configuredCanonical = canonicalizeEmailAddress(input.configuredEmail).canonical;
  } catch {
    throw new OwnerMfaRecoveryError("INVALID_RECOVERY_INPUT");
  }

  return db.transaction(async (tx) => {
    const owners = await tx
      .select({ userId: identityRoleGrants.userId })
      .from(identityRoleGrants)
      .where(and(eq(identityRoleGrants.role, "owner"), eq(identityRoleGrants.state, "active")))
      .for("update");
    if (owners.length !== 1 || owners[0]?.userId !== input.userId) {
      throw new OwnerMfaRecoveryError("OWNER_STATE_INVALID");
    }

    const [owner] = await tx
      .select({
        id: identityUsers.id,
        email: identityUsers.email,
        canonicalEmail: identityUsers.canonicalEmail,
        emailVerified: identityUsers.emailVerified,
        accessStatus: identityUsers.accessStatus,
        authorizationVersion: identityUsers.authorizationVersion,
        twoFactorEnabled: identityUsers.twoFactorEnabled,
      })
      .from(identityUsers)
      .where(eq(identityUsers.id, input.userId))
      .limit(1)
      .for("update");
    if (!owner || !owner.emailVerified || owner.accessStatus !== "active") {
      throw new OwnerMfaRecoveryError("OWNER_STATE_INVALID");
    }
    if (owner.canonicalEmail !== configuredCanonical) {
      throw new OwnerMfaRecoveryError("OWNER_EMAIL_MISMATCH");
    }

    const command = await beginIdempotentCommand(tx, {
      actorUserId: owner.id,
      commandScope: "owner.mfa_break_glass",
      keyHash: hashOpaqueToken(input.incidentId, "owner-mfa-recovery-incident"),
      requestFingerprint: hashOpaqueToken(
        `${input.userId}:${input.repositoryEvidenceId}:${input.hostEvidenceId}:${input.authorizedAt.toISOString()}:${input.emergencyReason ?? "standard"}`,
        "owner-mfa-recovery-request",
      ),
      now: input.now,
      expiresAt: new Date("9999-12-31T23:59:59.000Z"),
    });
    if (command.kind !== "acquired") {
      throw new OwnerMfaRecoveryError("RECOVERY_ALREADY_USED");
    }

    const invalidated = await tx
      .delete(identityTotpAuthenticators)
      .where(eq(identityTotpAuthenticators.userId, owner.id))
      .returning({ id: identityTotpAuthenticators.id });
    const revoked = await tx
      .update(identitySessions)
      .set({
        revokedAt: input.now,
        revocationReason: "owner_mfa_break_glass",
        updatedAt: input.now,
      })
      .where(and(eq(identitySessions.userId, owner.id), isNull(identitySessions.revokedAt)))
      .returning({ id: identitySessions.id });
    const [updatedOwner] = await tx
      .update(identityUsers)
      .set({
        twoFactorEnabled: false,
        authorizationVersion: sql`${identityUsers.authorizationVersion} + 1`,
        updatedAt: input.now,
      })
      .where(eq(identityUsers.id, owner.id))
      .returning({ authorizationVersion: identityUsers.authorizationVersion });
    if (!updatedOwner) throw new Error("Owner MFA recovery failed");

    const requestId = `breakglass:${input.incidentId}`;
    await appendAdminAuditEvent(tx, {
      actorUserId: owner.id,
      actorSessionId: null,
      subjectType: "identity_user",
      subjectId: owner.id,
      action: "identity.owner_mfa_break_glass",
      outcome: "succeeded",
      reasonCode: input.emergencyReason ?? "completed_wait_period",
      beforeState: {
        accessRevision: owner.authorizationVersion,
        twoFactorEnabled: owner.twoFactorEnabled,
      },
      afterState: {
        accessRevision: updatedOwner.authorizationVersion,
        twoFactorEnabled: false,
        sessionsRevoked: revoked.length,
        authenticatorsInvalidated: invalidated.length,
        ownerRoleChanged: false,
      },
      assurance: {
        method: "offline_break_glass",
        repositoryEvidenceId: input.repositoryEvidenceId,
        hostEvidenceId: input.hostEvidenceId,
        wait: input.emergencyReason ? "emergency_exception" : "twenty_four_hours",
        reenrollmentRequired: true,
      },
      applicationRevision: input.applicationRevision,
      requestId,
      occurredAt: input.now,
    });
    await queueSecurityEmailHandoff(tx, {
      id: randomUUID(),
      userId: owner.id,
      purpose: "security_notice",
      destination: owner.email,
      templateData: {
        event: "owner_mfa_break_glass_completed",
        returnPath: "/settings/security",
      },
      keyring: input.keyring,
      now: input.now,
    });
    const completed = await completeIdempotentCommand(tx, {
      recordId: command.recordId,
      resultReference: `owner-mfa-recovery:${input.incidentId}`,
      completedAt: input.now,
    });
    if (!completed) throw new Error("Owner MFA recovery failed");

    return {
      userId: owner.id,
      authorizationVersion: updatedOwner.authorizationVersion,
      revokedSessionCount: revoked.length,
      invalidatedAuthenticatorCount: invalidated.length,
    };
  });
}
