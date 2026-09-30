import {
  and,
  desc,
  eq,
  gt,
  isNull,
} from "drizzle-orm";

import { identitySecurityThrottles, identityEmailAddresses, identitySessions, identityUsers, type PawketDatabase } from "@pawket/database";


export function normalizeUserAgentFamily(userAgent: string | undefined): string {
  if (!userAgent) return "Unknown browser";
  if (/Edg\//u.test(userAgent)) return "Edge";
  if (/(?:Chrome|CriOS)\//u.test(userAgent)) return "Chrome";
  if (/(?:Firefox|FxiOS)\//u.test(userAgent)) return "Firefox";
  if (/Safari\//u.test(userAgent) && /Version\//u.test(userAgent)) return "Safari";
  return "Other browser";
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
