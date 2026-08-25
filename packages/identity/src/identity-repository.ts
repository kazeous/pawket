import {
  and,
  desc,
  eq,
  gt,
  isNull,
} from "drizzle-orm";

import {
  identitySecurityThrottles,
  identityEmailAddresses,
  identitySessions,
  identityUsers,
  identityVerifications,
  type PawketDatabase,
  type PawketTransaction,
} from "@pawket/database";
import { hashOpaqueToken } from "@pawket/security";

import { resolveSessionPolicy } from "./core-identity-policy.js";

type VerificationPurpose = "email_verification" | "password_reset" | "email_change";

export async function issueVerificationChallenge(
  tx: PawketTransaction,
  input: {
    id: string;
    userId: string;
    purpose: VerificationPurpose;
    identifierHash: string;
    token: string;
    targetEmail?: string;
    targetEmailCanonical?: string;
    now: Date;
    expiresAt: Date;
  },
): Promise<void> {
  await tx.insert(identityVerifications).values({
    id: input.id,
    userId: input.userId,
    purpose: input.purpose,
    identifier: input.identifierHash,
    value: hashOpaqueToken(input.token, `identity-${input.purpose}`),
    targetEmail: input.targetEmail,
    targetEmailCanonical: input.targetEmailCanonical,
    expiresAt: input.expiresAt,
    createdAt: input.now,
    updatedAt: input.now,
  });
}

export async function consumeVerificationChallenge(
  db: PawketDatabase,
  input: { purpose: VerificationPurpose; token: string; now: Date },
): Promise<{ id: string; userId: string; targetEmailCanonical: string | null } | null> {
  const [consumed] = await db
    .update(identityVerifications)
    .set({ consumedAt: input.now, updatedAt: input.now })
    .where(
      and(
        eq(identityVerifications.purpose, input.purpose),
        eq(
          identityVerifications.value,
          hashOpaqueToken(input.token, `identity-${input.purpose}`),
        ),
        isNull(identityVerifications.consumedAt),
        gt(identityVerifications.expiresAt, input.now),
      ),
    )
    .returning({
      id: identityVerifications.id,
      userId: identityVerifications.userId,
      targetEmailCanonical: identityVerifications.targetEmailCanonical,
    });

  if (!consumed?.userId) return null;
  return {
    id: consumed.id,
    userId: consumed.userId,
    targetEmailCanonical: consumed.targetEmailCanonical,
  };
}

export function normalizeUserAgentFamily(userAgent: string | undefined): string {
  if (!userAgent) return "Unknown browser";
  if (/Edg\//u.test(userAgent)) return "Edge";
  if (/(?:Chrome|CriOS)\//u.test(userAgent)) return "Chrome";
  if (/(?:Firefox|FxiOS)\//u.test(userAgent)) return "Firefox";
  if (/Safari\//u.test(userAgent) && /Version\//u.test(userAgent)) return "Safari";
  return "Other browser";
}

export async function createAuthoritativeSession(
  tx: PawketTransaction,
  input: {
    id: string;
    userId: string;
    token: string;
    kind: "user" | "owner" | "provisional" | "mfa_pending";
    authorizationVersion: number;
    now: Date;
    networkKey?: string;
    userAgent?: string;
  },
): Promise<void> {
  const policy = resolveSessionPolicy({ kind: input.kind, now: input.now });
  const assuranceState =
    input.kind === "provisional"
      ? "provisional"
      : input.kind === "mfa_pending"
        ? "mfa_pending"
        : "active";
  const expiresAt = new Date(
    Math.min(policy.absoluteExpiresAt.getTime(), policy.idleExpiresAt.getTime()),
  );

  await tx.insert(identitySessions).values({
    id: input.id,
    userId: input.userId,
    token: hashOpaqueToken(input.token, "identity-session"),
    expiresAt,
    createdAt: input.now,
    updatedAt: input.now,
    ipAddress: input.networkKey,
    userAgent: normalizeUserAgentFamily(input.userAgent),
    assuranceState,
    primaryAuthenticatedAt:
      assuranceState === "provisional" ? null : input.now,
    lastUsedAt: input.now,
    absoluteExpiresAt: policy.absoluteExpiresAt,
    idleExpiresAt: policy.idleExpiresAt,
    authorizationVersion: input.authorizationVersion,
  });
}

export async function resolveAuthoritativeSession(
  db: PawketDatabase,
  input: { token: string; now: Date },
): Promise<{
  sessionId: string;
  userId: string;
  emailVerified: boolean;
  accessStatus: "active";
  assuranceState: string;
} | null> {
  const [record] = await db
    .select({
      sessionId: identitySessions.id,
      userId: identitySessions.userId,
      assuranceState: identitySessions.assuranceState,
      sessionAuthorizationVersion: identitySessions.authorizationVersion,
      expiresAt: identitySessions.expiresAt,
      idleExpiresAt: identitySessions.idleExpiresAt,
      absoluteExpiresAt: identitySessions.absoluteExpiresAt,
      revokedAt: identitySessions.revokedAt,
      emailVerified: identityUsers.emailVerified,
      accessStatus: identityUsers.accessStatus,
      userAuthorizationVersion: identityUsers.authorizationVersion,
    })
    .from(identitySessions)
    .innerJoin(identityUsers, eq(identitySessions.userId, identityUsers.id))
    .where(
      eq(
        identitySessions.token,
        hashOpaqueToken(input.token, "identity-session"),
      ),
    )
    .limit(1);

  if (
    !record ||
    record.revokedAt !== null ||
    record.accessStatus !== "active" ||
    record.sessionAuthorizationVersion !== record.userAuthorizationVersion ||
    record.expiresAt <= input.now ||
    record.idleExpiresAt <= input.now ||
    record.absoluteExpiresAt <= input.now
  ) {
    return null;
  }

  return {
    sessionId: record.sessionId,
    userId: record.userId,
    emailVerified: record.emailVerified,
    accessStatus: "active",
    assuranceState: record.assuranceState,
  };
}

export async function resolveAuthoritativeSessionById(
  db: PawketDatabase,
  input: { sessionId: string; userId: string; now: Date },
): Promise<{
  sessionId: string;
  userId: string;
  primaryAuthenticatedAt: Date;
} | null> {
  const [record] = await db
    .select({
      sessionId: identitySessions.id,
      userId: identitySessions.userId,
      assuranceState: identitySessions.assuranceState,
      primaryAuthenticatedAt: identitySessions.primaryAuthenticatedAt,
      sessionAuthorizationVersion: identitySessions.authorizationVersion,
      expiresAt: identitySessions.expiresAt,
      idleExpiresAt: identitySessions.idleExpiresAt,
      absoluteExpiresAt: identitySessions.absoluteExpiresAt,
      revokedAt: identitySessions.revokedAt,
      emailVerified: identityUsers.emailVerified,
      accessStatus: identityUsers.accessStatus,
      userAuthorizationVersion: identityUsers.authorizationVersion,
    })
    .from(identitySessions)
    .innerJoin(identityUsers, eq(identitySessions.userId, identityUsers.id))
    .where(
      and(
        eq(identitySessions.id, input.sessionId),
        eq(identitySessions.userId, input.userId),
      ),
    )
    .limit(1);

  if (
    !record ||
    record.revokedAt !== null ||
    record.accessStatus !== "active" ||
    !record.emailVerified ||
    record.assuranceState !== "active" ||
    !record.primaryAuthenticatedAt ||
    record.sessionAuthorizationVersion !== record.userAuthorizationVersion ||
    record.expiresAt <= input.now ||
    record.idleExpiresAt <= input.now ||
    record.absoluteExpiresAt <= input.now
  ) {
    return null;
  }

  return {
    sessionId: record.sessionId,
    userId: record.userId,
    primaryAuthenticatedAt: record.primaryAuthenticatedAt,
  };
}

export async function listUserSessions(
  db: PawketDatabase,
  input: { userId: string; now: Date },
): Promise<Array<{ id: string; deviceLabel: string; createdAt: Date; lastUsedAt: Date }>> {
  const rows = await db
    .select({
      id: identitySessions.id,
      deviceLabel: identitySessions.userAgent,
      createdAt: identitySessions.createdAt,
      lastUsedAt: identitySessions.lastUsedAt,
    })
    .from(identitySessions)
    .where(
      and(
        eq(identitySessions.userId, input.userId),
        isNull(identitySessions.revokedAt),
        gt(identitySessions.expiresAt, input.now),
      ),
    )
    .orderBy(desc(identitySessions.lastUsedAt));

  return rows.map((row) => ({
    id: row.id,
    deviceLabel: row.deviceLabel ?? "Unknown browser",
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  }));
}

export async function getIdentityUserSummary(
  db: PawketDatabase,
  userId: string,
): Promise<{
  id: string;
  displayName: string;
  displayEmail: string;
  emailVerified: boolean;
  accessStatus: string;
} | null> {
  const [user] = await db
    .select({
      id: identityUsers.id,
      displayName: identityUsers.name,
      displayEmail: identityEmailAddresses.displayEmail,
      emailVerified: identityUsers.emailVerified,
      accessStatus: identityUsers.accessStatus,
    })
    .from(identityUsers)
    .innerJoin(
      identityEmailAddresses,
      and(
        eq(identityEmailAddresses.userId, identityUsers.id),
        eq(identityEmailAddresses.status, "primary"),
      ),
    )
    .where(eq(identityUsers.id, userId))
    .limit(1);
  return user ?? null;
}

export async function revokeUserSession(
  db: PawketDatabase,
  input: { userId: string; sessionId: string; reason: string; now: Date },
): Promise<boolean> {
  const rows = await db
    .update(identitySessions)
    .set({
      revokedAt: input.now,
      revocationReason: input.reason.slice(0, 100),
      updatedAt: input.now,
    })
    .where(
      and(
        eq(identitySessions.id, input.sessionId),
        eq(identitySessions.userId, input.userId),
        isNull(identitySessions.revokedAt),
      ),
    )
    .returning({ id: identitySessions.id });
  return rows.length === 1;
}

export async function revokeUserSessionInTransaction(
  tx: PawketTransaction,
  input: { userId: string; sessionId: string; reason: string; now: Date },
): Promise<boolean> {
  const rows = await tx
    .update(identitySessions)
    .set({
      revokedAt: input.now,
      revocationReason: input.reason.slice(0, 100),
      updatedAt: input.now,
    })
    .where(
      and(
        eq(identitySessions.id, input.sessionId),
        eq(identitySessions.userId, input.userId),
        isNull(identitySessions.revokedAt),
      ),
    )
    .returning({ id: identitySessions.id });
  return rows.length === 1;
}

export async function revokeAllUserSessions(
  tx: PawketTransaction,
  input: { userId: string; reason: string; now: Date; exceptSessionId?: string },
): Promise<number> {
  const sessions = await tx
    .select({ id: identitySessions.id })
    .from(identitySessions)
    .where(and(eq(identitySessions.userId, input.userId), isNull(identitySessions.revokedAt)));
  const targets = sessions.filter((session) => session.id !== input.exceptSessionId);
  if (targets.length === 0) return 0;

  let revoked = 0;
  for (const target of targets) {
    const updated = await tx
      .update(identitySessions)
      .set({
        revokedAt: input.now,
        revocationReason: input.reason.slice(0, 100),
        updatedAt: input.now,
      })
      .where(and(eq(identitySessions.id, target.id), isNull(identitySessions.revokedAt)))
      .returning({ id: identitySessions.id });
    revoked += updated.length;
  }
  return revoked;
}

export async function recordSecurityThrottleAttempt(
  db: PawketDatabase,
  input: {
    scope: "account" | "network";
    subjectHmac: string;
    action: string;
    now: Date;
    windowMs: number;
    maximumAttempts: number;
    blockMs: number;
  },
): Promise<{ allowed: boolean; attemptCount: number; retryAt: Date | null; risk: string }> {
  if (
    input.windowMs <= 0 ||
    input.maximumAttempts <= 0 ||
    input.blockMs <= 0 ||
    !Number.isSafeInteger(input.maximumAttempts)
  ) {
    throw new Error("Invalid throttle policy");
  }

  return db.transaction(async (tx) => {
    await tx
      .insert(identitySecurityThrottles)
      .values({
        scope: input.scope,
        subjectHmac: input.subjectHmac,
        action: input.action,
        attemptCount: 0,
        windowStartedAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing();

    const [current] = await tx
      .select()
      .from(identitySecurityThrottles)
      .where(
        and(
          eq(identitySecurityThrottles.scope, input.scope),
          eq(identitySecurityThrottles.subjectHmac, input.subjectHmac),
          eq(identitySecurityThrottles.action, input.action),
        ),
      )
      .limit(1)
      .for("update");
    if (!current) throw new Error("Security throttle update failed");

    const existingBlock = current.blockedUntil && current.blockedUntil > input.now
      ? current.blockedUntil
      : null;
    const windowExpired =
      current.windowStartedAt.getTime() + input.windowMs <= input.now.getTime();
    const attemptCount = windowExpired ? 1 : current.attemptCount + 1;
    const retryAt =
      existingBlock ??
      (attemptCount > input.maximumAttempts
        ? new Date(input.now.getTime() + input.blockMs)
        : null);
    const risk = retryAt
      ? "challenge_required"
      : attemptCount >= input.maximumAttempts
        ? "elevated"
        : "normal";

    await tx
      .update(identitySecurityThrottles)
      .set({
        attemptCount,
        windowStartedAt: windowExpired ? input.now : current.windowStartedAt,
        blockedUntil: retryAt,
        riskLevel: risk,
        updatedAt: input.now,
      })
      .where(eq(identitySecurityThrottles.id, current.id));

    return { allowed: retryAt === null, attemptCount, retryAt, risk };
  });
}

export async function clearSecurityThrottle(
  db: PawketDatabase,
  input: {
    scope: "account" | "network";
    subjectHmac: string;
    action: string;
  },
): Promise<void> {
  await db
    .delete(identitySecurityThrottles)
    .where(
      and(
        eq(identitySecurityThrottles.scope, input.scope),
        eq(identitySecurityThrottles.subjectHmac, input.subjectHmac),
        eq(identitySecurityThrottles.action, input.action),
      ),
    );
}
