import { and, eq, gt, isNotNull, isNull } from "drizzle-orm";

import {
  identityRoleGrants,
  identitySessions,
  identityTotpAuthenticators,
  identityUsers,
  type PawketDatabase,
} from "@pawket/database";

export async function resolveOwnerSessionPermission(
  db: PawketDatabase,
  input: { userId: string; sessionId: string; now: Date },
): Promise<boolean> {
  if (Number.isNaN(input.now.getTime())) return false;

  const [owner] = await db
    .select({ id: identityRoleGrants.id })
    .from(identityRoleGrants)
    .innerJoin(identityUsers, eq(identityUsers.id, identityRoleGrants.userId))
    .innerJoin(
      identityTotpAuthenticators,
      eq(identityTotpAuthenticators.userId, identityRoleGrants.userId),
    )
    .innerJoin(
      identitySessions,
      and(
        eq(identitySessions.userId, identityRoleGrants.userId),
        eq(identitySessions.id, input.sessionId),
      ),
    )
    .where(
      and(
        eq(identityRoleGrants.userId, input.userId),
        eq(identityRoleGrants.role, "owner"),
        eq(identityRoleGrants.state, "active"),
        eq(identityUsers.accessStatus, "active"),
        eq(identityUsers.emailVerified, true),
        eq(identityUsers.twoFactorEnabled, true),
        eq(identityTotpAuthenticators.verified, true),
        eq(identitySessions.assuranceState, "active"),
        eq(identitySessions.authorizationVersion, identityUsers.authorizationVersion),
        isNotNull(identitySessions.primaryAuthenticatedAt),
        isNotNull(identitySessions.mfaVerifiedAt),
        isNull(identitySessions.revokedAt),
        gt(identitySessions.expiresAt, input.now),
        gt(identitySessions.idleExpiresAt, input.now),
        gt(identitySessions.absoluteExpiresAt, input.now),
      ),
    )
    .limit(1);

  return Boolean(owner);
}
