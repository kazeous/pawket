import { and, eq } from "drizzle-orm";
import { identityRoleGrants, identitySessions, identityUsers, type PawketTransaction } from "@pawket/database";
import { readOidcSessionEvidence, type OidcSessionProvider } from "./oidc-session.js";

export type OidcAssuranceActor = { userId: string; sessionId: string };

/** Business mutations use user -> session locks, shared with the logout fence. */
export function createOidcAssurancePort(provider: OidcSessionProvider, clock: () => Date = () => new Date()) {
  async function read(tx: PawketTransaction, actor: OidcAssuranceActor, at: Date) {
    if (!Number.isFinite(at.getTime())) return null;
    const [user] = await tx.select({ version: identityUsers.authorizationVersion, active: identityUsers.accessStatus,
      verified: identityUsers.emailVerified }).from(identityUsers).where(eq(identityUsers.id, actor.userId)).for("share");
    if (!user || user.active !== "active" || !user.verified) return null;
    const [session] = await tx.select().from(identitySessions).where(and(eq(identitySessions.id, actor.sessionId),
      eq(identitySessions.userId, actor.userId))).for("share");
    // A request may wait on a revocation/business lock. Evaluate time after the
    // fence, never extend evidence using the timestamp captured before waiting.
    at = new Date(Math.max(at.getTime(), clock().getTime()));
    if (!Number.isFinite(at.getTime())) return null;
    if (!session || session.revokedAt || session.assuranceState !== "active" || session.authorizationVersion !== user.version ||
      !session.primaryAuthenticatedAt || session.primaryAuthenticatedAt > at || session.createdAt > at ||
      session.expiresAt <= at || session.idleExpiresAt <= at || session.absoluteExpiresAt <= at) return null;
    const evidence = await readOidcSessionEvidence(tx, { ...actor, now: at, provider });
    if (!evidence || evidence.mfaStatus === "unknown") return null;
    const mfaVerifiedAt = evidence.mfaStatus === "enrolled" && session.mfaVerifiedAt &&
      session.mfaVerifiedAt >= session.primaryAuthenticatedAt && session.mfaVerifiedAt <= at ? session.mfaVerifiedAt : null;
    return { primaryAuthenticatedAt: session.primaryAuthenticatedAt, mfaEnrolled: evidence.mfaStatus === "enrolled",
      mfaVerifiedAt, sessionExpiresAt: new Date(Math.min(session.expiresAt.getTime(), session.idleExpiresAt.getTime(),
        session.absoluteExpiresAt.getTime(), evidence.idpValidUntil.getTime())), authorizationVersion: user.version,
      transactionId: evidence.transactionId, subject: evidence.subject, checkedAt: at };
  }
  async function owner(tx: PawketTransaction, actor: OidcAssuranceActor, at: Date): Promise<boolean> {
    const assurance = await read(tx, actor, at);
    if (!assurance?.mfaEnrolled || !assurance.mfaVerifiedAt) return false;
    const [role] = await tx.select({ id: identityRoleGrants.id }).from(identityRoleGrants).where(and(
      eq(identityRoleGrants.userId, actor.userId), eq(identityRoleGrants.role, "owner"), eq(identityRoleGrants.state, "active"),
    )).for("share");
    return Boolean(role) && assurance.sessionExpiresAt > clock();
  }
  return { read, getTipSessionAssurance: read, authorizeOwner: owner };
}
