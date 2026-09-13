import { identitySessions, identityTotpAuthenticators, identityUsers, type PawketTransaction } from "@pawket/database";
import { and, eq } from "drizzle-orm";

export type TipSessionAssurance = Readonly<{
  primaryAuthenticatedAt: Date; totpEnrolled: boolean; totpVerifiedAt: Date | null; sessionExpiresAt: Date;
}>;

export function createIdentityTipAssurancePort() {
  return {
    async getTipSessionAssurance(tx: PawketTransaction, actor: { userId: string; sessionId: string }, at: Date): Promise<TipSessionAssurance | null> {
      const [user] = await tx.select({ authorizationVersion: identityUsers.authorizationVersion, accessStatus: identityUsers.accessStatus,
        emailVerified: identityUsers.emailVerified, twoFactorEnabled: identityUsers.twoFactorEnabled }).from(identityUsers).where(eq(identityUsers.id, actor.userId)).limit(1).for("share");
      if (!user || user.accessStatus !== "active" || !user.emailVerified) return null;
      const [session] = await tx.select().from(identitySessions).where(and(eq(identitySessions.id, actor.sessionId), eq(identitySessions.userId, actor.userId))).limit(1).for("share");
      if (!session || session.revokedAt || session.assuranceState !== "active" || session.authorizationVersion !== user.authorizationVersion ||
        !session.primaryAuthenticatedAt || session.createdAt > at || session.expiresAt <= at || session.idleExpiresAt <= at || session.absoluteExpiresAt <= at) return null;
      // Recovery locks/deletes this row before updating the user. The user share
      // lock above is the commit fence; adding an authenticator lock here would
      // reverse that existing order. Never read its secret envelope.
      const [factor] = await tx.select({ verified: identityTotpAuthenticators.verified, createdAt: identityTotpAuthenticators.createdAt, lastUsedStep: identityTotpAuthenticators.lastUsedStep })
        .from(identityTotpAuthenticators).where(eq(identityTotpAuthenticators.userId, actor.userId)).limit(1);
      const totpEnrolled = Boolean(user.twoFactorEnabled || factor?.verified);
      const totpVerifiedAt = user.twoFactorEnabled && factor?.verified && factor.lastUsedStep !== null && session.mfaVerifiedAt && session.mfaVerifiedAt >= factor.createdAt
        ? session.mfaVerifiedAt : null;
      return Object.freeze({ primaryAuthenticatedAt: session.primaryAuthenticatedAt, totpEnrolled, totpVerifiedAt,
        sessionExpiresAt: new Date(Math.min(session.expiresAt.getTime(), session.idleExpiresAt.getTime(), session.absoluteExpiresAt.getTime())) });
    },
  };
}
