import { and, eq, isNull } from "drizzle-orm";
import {
  identityAccounts, identityOidcSessions, identityRoleGrants, identitySessions, identityUsers,
  type PawketDatabase, type PawketTransaction,
} from "@pawket/database";
import { hashOpaqueToken } from "@pawket/security";

export function hashSessionToken(token: string): string {
  return hashOpaqueToken(token, "identity-session");
}
import { resolveSessionPolicy, type SessionLifetimes } from "./core-identity-policy.js";
import type { OidcProviderConfig } from "./oidc-protocol.js";
import type { OidcActorBinding } from "./oidc-transactions.js";

export type OidcSessionContext = OidcActorBinding & Readonly<{
  primaryAuthenticatedAt: Date; mfaVerifiedAt: Date | null; totpStatus: string;
  sessionExpiresAt: Date; idpValidUntil: Date; leaseRequired: boolean; owner: boolean;
}>;
export type OidcSessionProvider = Pick<OidcProviderConfig, "issuer" | "clientId" | "providerRevision">;

/** Use under the user then session commit fences held by the calling domain. */
export async function readOidcSessionEvidence(tx: PawketTransaction, input: {
  userId: string; sessionId: string; now: Date; provider: OidcSessionProvider;
}) {
  const [evidence] = await tx.select({
    sid: identityOidcSessions.sid, subject: identityAccounts.accountId,
    totpStatus: identityOidcSessions.totpStatus, idpValidUntil: identityOidcSessions.idpValidUntil,
    transactionId: identityOidcSessions.transactionId,
  }).from(identityOidcSessions).innerJoin(identityAccounts, eq(identityAccounts.id, identityOidcSessions.accountId))
    .where(and(eq(identityOidcSessions.sessionId, input.sessionId), eq(identityOidcSessions.userId, input.userId),
      eq(identityAccounts.userId, input.userId), eq(identityAccounts.providerId, "authentik"), eq(identityAccounts.issuer, input.provider.issuer),
      eq(identityOidcSessions.clientId, input.provider.clientId), eq(identityOidcSessions.providerRevision, input.provider.providerRevision)))
    .limit(1);
  if (!evidence || evidence.idpValidUntil <= input.now) return null;
  return evidence;
}

export function createOidcSessionResolver(deps: { db: PawketDatabase; provider: OidcSessionProvider; now?: () => Date; lifetimes?: SessionLifetimes }) {
  const clock = deps.now ?? (() => new Date());
  return async (input: { token: string; now: Date; allowExpiredLease?: boolean; touch?: boolean }): Promise<OidcSessionContext | null> => {
    if (!/^[A-Za-z0-9_-]{43,128}$/u.test(input.token) || !Number.isFinite(input.now.getTime())) return null;
    const digest = hashOpaqueToken(input.token, "identity-session");
    const [candidate] = await deps.db.select({ userId: identitySessions.userId, sessionId: identitySessions.id }).from(identitySessions)
      .where(and(eq(identitySessions.token, digest), isNull(identitySessions.revokedAt))).limit(1);
    if (!candidate) return null;
    return deps.db.transaction(async (tx) => {
      const [user] = await tx.select({ authorizationVersion: identityUsers.authorizationVersion, accessStatus: identityUsers.accessStatus,
        emailVerified: identityUsers.emailVerified }).from(identityUsers).where(eq(identityUsers.id, candidate.userId)).for("share");
      if (!user || user.accessStatus !== "active" || !user.emailVerified) return null;
      const [session] = await tx.select().from(identitySessions).where(and(
        eq(identitySessions.id, candidate.sessionId), eq(identitySessions.userId, candidate.userId), eq(identitySessions.token, digest),
      )).for("update");
      let at = new Date(Math.max(input.now.getTime(), clock().getTime()));
      if (!Number.isFinite(at.getTime())) return null;
      if (!session || session.revokedAt || session.authorizationVersion !== user.authorizationVersion || session.assuranceState !== "active" ||
        !session.primaryAuthenticatedAt || session.primaryAuthenticatedAt > at || session.createdAt > at ||
        session.expiresAt <= at || session.idleExpiresAt <= at || session.absoluteExpiresAt <= at) return null;
      const [sidecar] = await tx.select({ subject: identityAccounts.accountId, totpStatus: identityOidcSessions.totpStatus,
        idpValidUntil: identityOidcSessions.idpValidUntil }).from(identityOidcSessions)
        .innerJoin(identityAccounts, eq(identityAccounts.id, identityOidcSessions.accountId))
        .where(and(eq(identityOidcSessions.sessionId, session.id), eq(identityOidcSessions.userId, session.userId),
          eq(identityAccounts.userId, session.userId), eq(identityAccounts.providerId, "authentik"), eq(identityAccounts.issuer, deps.provider.issuer),
          eq(identityOidcSessions.clientId, deps.provider.clientId), eq(identityOidcSessions.providerRevision, deps.provider.providerRevision))).limit(1);
      if (!sidecar) return null;
      const [role] = await tx.select({ id: identityRoleGrants.id }).from(identityRoleGrants).where(and(
        eq(identityRoleGrants.userId, session.userId), eq(identityRoleGrants.role, "owner"), eq(identityRoleGrants.state, "active"),
      )).limit(1);
      at = new Date(Math.max(at.getTime(), clock().getTime()));
      if (!Number.isFinite(at.getTime()) || session.expiresAt <= at || session.idleExpiresAt <= at || session.absoluteExpiresAt <= at) return null;
      const leaseRequired = sidecar.idpValidUntil <= at;
      if (leaseRequired && !input.allowExpiredLease) return null;
      const owner = Boolean(role);
      let sessionExpiresAt = session.expiresAt;
      if (input.touch && !leaseRequired && at.getTime() - session.lastUsedAt.getTime() >= 60_000) {
        const policy = resolveSessionPolicy({ kind: owner ? "owner" : "user", now: at, lifetimes: deps.lifetimes });
        sessionExpiresAt = new Date(Math.min(session.absoluteExpiresAt.getTime(), policy.idleExpiresAt.getTime()));
        await tx.update(identitySessions).set({ lastUsedAt: at, idleExpiresAt: policy.idleExpiresAt, expiresAt: sessionExpiresAt, updatedAt: at })
          .where(eq(identitySessions.id, session.id));
      }
      return { userId: session.userId, sessionId: session.id, authorizationVersion: user.authorizationVersion,
        subject: sidecar.subject, primaryAuthenticatedAt: session.primaryAuthenticatedAt, mfaVerifiedAt: session.mfaVerifiedAt,
        totpStatus: sidecar.totpStatus, sessionExpiresAt, idpValidUntil: sidecar.idpValidUntil, leaseRequired, owner };
    });
  };
}
