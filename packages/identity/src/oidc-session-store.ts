import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  appendAdminAuditEvent, identityAccounts, identityEmailAddresses, identityOidcLogoutEvents, identityOidcOwnerLinks,
  identityOidcPendingCommands, identityOidcRevocations, identityOidcSessions, identityRoleGrants,
  identitySessions, identityStepUpProofs, identityUsers,
  type PawketDatabase, type PawketTransaction,
} from "@pawket/database";
import { hashOpaqueToken } from "@pawket/security";
import { normalizeUserAgentFamily } from "./identity-repository.js";
import { resolveSessionPolicy, type SessionLifetimes } from "./core-identity-policy.js";
import { assertOidcStepUp, oidcLeaseDeadline, OidcIdentityError, type OidcEvidence } from "./oidc-policy.js";
import { lockOidcRevocationScope, type OidcTransaction } from "./oidc-transactions.js";
import type { OidcLogout, OidcProviderConfig } from "./oidc-protocol.js";

type AcceptResult =
  | { ok: false; code: OidcIdentityError["code"] }
  | { ok: true; userId: string; sessionId: string; authorizationVersion: number; expiresAt: Date; rotated: boolean };
const reject = (code: OidcIdentityError["code"]): AcceptResult => ({ ok: false, code });

/** Caller holds the user UPDATE lock; domain writes take the matching SHARE lock. */
export async function revokeOidcUserSessions(tx: PawketTransaction, input: {
  userId: string; now: Date; reason: string; sessionIds?: string[];
}): Promise<void> {
  const scope = and(eq(identitySessions.userId, input.userId),
    ...(input.sessionIds ? [inArray(identitySessions.id, input.sessionIds)] : []));
  const sessions = await tx.select({ id: identitySessions.id }).from(identitySessions).where(scope).orderBy(identitySessions.id).for("update");
  if (!sessions.length) return;
  const ids = sessions.map((session) => session.id);
  await tx.update(identitySessions).set({ revokedAt: input.now, revocationReason: input.reason, updatedAt: input.now })
    .where(and(inArray(identitySessions.id, ids), isNull(identitySessions.revokedAt)));
  await tx.update(identityStepUpProofs).set({ consumedAt: input.now })
    .where(and(inArray(identityStepUpProofs.sessionId, ids), isNull(identityStepUpProofs.consumedAt)));
  await tx.update(identityOidcPendingCommands).set({ consumedAt: input.now, payloadEnvelope: null })
    .where(and(inArray(identityOidcPendingCommands.sessionId, ids), isNull(identityOidcPendingCommands.consumedAt)));
}

/** Local logout never calls the IdP. All-session logout also fences in-flight callbacks. */
export async function revokeOidcLocalSessions(tx: PawketTransaction, input: {
  userId: string; sessionId?: string; now: Date; reason: string;
}, provider: Pick<OidcProviderConfig, "issuer" | "clientId">): Promise<number> {
  if (!input.sessionId) {
    const accounts = await tx.select({ subject: identityAccounts.accountId }).from(identityAccounts).where(and(
      eq(identityAccounts.userId, input.userId), eq(identityAccounts.providerId, "authentik"), eq(identityAccounts.issuer, provider.issuer),
    )).orderBy(identityAccounts.accountId);
    for (const account of accounts) {
      await lockOidcRevocationScope(tx, { ...provider, subject: account.subject });
      await tx.insert(identityOidcRevocations).values({ ...provider, kind: "local_sub", subjectKey: account.subject,
        revokedThrough: input.now, receivedAt: input.now }).onConflictDoUpdate({
        target: [identityOidcRevocations.issuer, identityOidcRevocations.clientId, identityOidcRevocations.kind, identityOidcRevocations.subjectKey],
        set: { revokedThrough: sql`greatest(${identityOidcRevocations.revokedThrough}, ${input.now.toISOString()}::timestamptz)`, receivedAt: input.now },
      });
    }
  }
  const [user] = await tx.select({ id: identityUsers.id }).from(identityUsers).where(eq(identityUsers.id, input.userId)).for("update");
  if (!user) return 0;
  const targets = await tx.select({ id: identitySessions.id }).from(identitySessions).where(and(
    eq(identitySessions.userId, input.userId), isNull(identitySessions.revokedAt),
    ...(input.sessionId ? [eq(identitySessions.id, input.sessionId)] : []),
  )).orderBy(identitySessions.id).for("update");
  if (!input.sessionId) await tx.update(identityUsers).set({ authorizationVersion: sql`${identityUsers.authorizationVersion} + 1`,
    updatedAt: input.now }).where(eq(identityUsers.id, input.userId));
  if (targets.length) await revokeOidcUserSessions(tx, { ...input, sessionIds: targets.map((item) => item.id) });
  return targets.length;
}

async function isOwner(tx: PawketTransaction, userId: string): Promise<boolean> {
  const [role] = await tx.select({ id: identityRoleGrants.id }).from(identityRoleGrants).where(and(
    eq(identityRoleGrants.userId, userId), eq(identityRoleGrants.role, "owner"), eq(identityRoleGrants.state, "active"),
  )).limit(1);
  return Boolean(role);
}

async function lockEmail(tx: PawketTransaction, email: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["pawket-oidc-email", email])}, 0))`);
}

async function emailCollision(tx: PawketTransaction, canonical: string, userId?: string): Promise<boolean> {
  const users = await tx.select({ userId: identityUsers.id }).from(identityUsers).where(eq(identityUsers.canonicalEmail, canonical));
  const addresses = await tx.select({ userId: identityEmailAddresses.userId }).from(identityEmailAddresses).where(eq(identityEmailAddresses.canonicalEmail, canonical));
  return [...users, ...addresses].some((row) => row.userId !== userId);
}

async function markUnverified(tx: PawketTransaction, userId: string, now: Date): Promise<void> {
  await tx.update(identityUsers).set({ emailVerified: false, emailVerifiedAt: null, emailVerificationProvenance: null,
    authorizationVersion: sql`${identityUsers.authorizationVersion} + 1`, updatedAt: now }).where(eq(identityUsers.id, userId));
  await tx.update(identityEmailAddresses).set({ verifiedAt: null, verificationProvenance: null, updatedAt: now })
    .where(and(eq(identityEmailAddresses.userId, userId), eq(identityEmailAddresses.status, "primary")));
  await revokeOidcUserSessions(tx, { userId, now, reason: "idp_email_invalid" });
}

async function storePrimaryEmail(tx: PawketTransaction, userId: string, evidence: OidcEvidence, now: Date): Promise<void> {
  await tx.update(identityEmailAddresses).set({ status: "previous", replacedAt: now, updatedAt: now })
    .where(and(eq(identityEmailAddresses.userId, userId), eq(identityEmailAddresses.status, "primary")));
  await tx.insert(identityEmailAddresses).values({ userId, displayEmail: evidence.email, canonicalEmail: evidence.canonicalEmail,
    status: "primary", verifiedAt: now, verificationProvenance: "provider_assertion", createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: identityEmailAddresses.canonicalEmail, set: {
      displayEmail: evidence.email, status: "primary", verifiedAt: now, verificationProvenance: "provider_assertion", replacedAt: null, updatedAt: now,
    }, setWhere: eq(identityEmailAddresses.userId, userId) });
}

export function createOidcSessionStore(deps: { db: PawketDatabase; config: OidcProviderConfig; applicationRevision?: string; now?: () => Date; lifetimes?: SessionLifetimes }) {
  const { db, config } = deps;
  const clock = deps.now ?? (() => new Date());
  return {
    /** Called inside transaction completion. Return denials so revocation is COMMITTED. */
    async accept(tx: PawketTransaction, input: {
      transaction: OidcTransaction; evidence: OidcEvidence; now: Date;
      newSessionToken: string; userAgent?: string; networkKey?: string;
    }): Promise<AcceptResult> {
      const { transaction, evidence } = input;
      let now = input.now;
      const expired = () => {
        now = new Date(Math.max(now.getTime(), clock().getTime()));
        return !Number.isFinite(now.getTime()) || oidcLeaseDeadline(transaction.createdAt, transaction.expiresAt) <= now;
      };
      if (evidence.issuer !== config.issuer || evidence.providerRevision !== config.providerRevision ||
        transaction.issuer !== config.issuer || transaction.clientId !== config.clientId || transaction.providerRevision !== config.providerRevision) return reject("invalid_response");
      if (transaction.expectedSubject && transaction.expectedSubject !== evidence.subject) return reject("actor_changed");
      if (oidcLeaseDeadline(transaction.createdAt, transaction.expiresAt) <= now) return reject("transaction_expired");
      await lockOidcRevocationScope(tx, { issuer: config.issuer, clientId: config.clientId, subject: evidence.subject, sid: evidence.sid });
      if (expired()) return reject("transaction_expired");
      const fences = await tx.select().from(identityOidcRevocations).where(and(
        eq(identityOidcRevocations.issuer, config.issuer), eq(identityOidcRevocations.clientId, config.clientId),
        or(and(eq(identityOidcRevocations.kind, "sid"), eq(identityOidcRevocations.subjectKey, evidence.sid)),
          and(inArray(identityOidcRevocations.kind, ["sub", "local_sub"]), eq(identityOidcRevocations.subjectKey, evidence.subject))),
      ));
      if (fences.some((fence) => fence.kind === "sid" || (fence.kind === "local_sub" ? transaction.createdAt <= fence.revokedThrough : evidence.primaryAt <= fence.revokedThrough))) return reject("session_revoked");
      await lockEmail(tx, evidence.canonicalEmail);
      if (expired()) return reject("transaction_expired");
      let [account] = await tx.select().from(identityAccounts).where(and(
        eq(identityAccounts.issuer, config.issuer), eq(identityAccounts.accountId, evidence.subject), eq(identityAccounts.providerId, "authentik"),
      )).limit(1);

      // Existing identities are never located by email. A pin created by an operator is required for linking.
      let userId = account?.userId ?? transaction.expectedUserId;
      if (transaction.purpose === "owner_link") {
        if (!transaction.expectedUserId || (account && account.userId !== transaction.expectedUserId)) return reject("identity_conflict");
        userId = transaction.expectedUserId;
      } else if (!account && transaction.purpose !== "login") return reject("actor_changed");
      if (!userId) {
        if (!evidence.emailVerified) return reject("email_unverified");
        if (await emailCollision(tx, evidence.canonicalEmail)) return reject("identity_conflict");
        userId = randomUUID();
        await tx.insert(identityUsers).values({ id: userId, name: evidence.name, email: evidence.email, canonicalEmail: evidence.canonicalEmail,
          emailVerified: true, emailVerifiedAt: now, emailVerificationProvenance: "provider_assertion", createdAt: now, updatedAt: now });
        await storePrimaryEmail(tx, userId, evidence, now);
      }
      const [user] = await tx.select().from(identityUsers).where(eq(identityUsers.id, userId)).for("update");
      if (expired()) return reject("transaction_expired");
      if (!user || user.accessStatus !== "active") return reject("session_revoked");
      if (transaction.expectedUserId && (user.id !== transaction.expectedUserId || user.authorizationVersion !== transaction.expectedAuthorizationVersion)) return reject("actor_changed");
      const owner = await isOwner(tx, user.id);
      if (transaction.purpose === "owner_link") {
        if (!owner) return reject("actor_changed");
        const otherAccounts = await tx.select({ subject: identityAccounts.accountId }).from(identityAccounts).where(and(
          eq(identityAccounts.userId, user.id), eq(identityAccounts.issuer, config.issuer), eq(identityAccounts.providerId, "authentik"),
        ));
        if (otherAccounts.some((existing) => existing.subject !== evidence.subject)) return reject("identity_conflict");
        try { assertOidcStepUp(evidence, { expectedSubject: transaction.expectedSubject!, requestedAt: transaction.createdAt, now, owner: true }); }
        catch { return reject("assurance_required"); }
        const [link] = await tx.update(identityOidcOwnerLinks).set({ consumedAt: now }).where(and(
          eq(identityOidcOwnerLinks.userId, user.id), eq(identityOidcOwnerLinks.subject, evidence.subject),
          eq(identityOidcOwnerLinks.issuer, config.issuer), eq(identityOidcOwnerLinks.clientId, config.clientId),
          eq(identityOidcOwnerLinks.providerRevision, config.providerRevision), isNull(identityOidcOwnerLinks.consumedAt),
          lte(identityOidcOwnerLinks.approvedAt, transaction.createdAt), gt(identityOidcOwnerLinks.expiresAt, now),
        )).returning({ id: identityOidcOwnerLinks.id });
        if (!link) return reject("actor_changed");
      }
      if (!evidence.emailVerified || await emailCollision(tx, evidence.canonicalEmail, user.id)) {
        await markUnverified(tx, user.id, now);
        return reject(evidence.emailVerified ? "identity_conflict" : "email_unverified");
      }
      const emailChanged = user.canonicalEmail !== evidence.canonicalEmail || !user.emailVerified;
      let authorizationVersion = user.authorizationVersion;
      if (emailChanged || transaction.purpose === "owner_link") {
        authorizationVersion++;
        await tx.update(identityUsers).set({ email: evidence.email, canonicalEmail: evidence.canonicalEmail, emailVerified: true,
          emailVerifiedAt: now, emailVerificationProvenance: "provider_assertion", authorizationVersion, updatedAt: now }).where(eq(identityUsers.id, user.id));
        await storePrimaryEmail(tx, user.id, evidence, now);
        await revokeOidcUserSessions(tx, { userId: user.id, now, reason: emailChanged ? "idp_email_changed" : "oidc_owner_linked" });
        if (transaction.purpose === "lease_check" || transaction.purpose === "step_up") return reject("session_revoked");
      }
      if (!account) {
        [account] = await tx.insert(identityAccounts).values({ id: randomUUID(), userId: user.id, issuer: config.issuer,
          accountId: evidence.subject, providerId: "authentik", createdAt: now, updatedAt: now }).returning();
      }
      if (!account || account.userId !== user.id) return reject("identity_conflict");
      if (transaction.purpose === "lease_check" || transaction.purpose === "step_up") {
        const [session] = await tx.select().from(identitySessions).where(and(
          eq(identitySessions.id, transaction.expectedSessionId!), eq(identitySessions.userId, user.id),
        )).for("update");
        const [sidecar] = session ? await tx.select().from(identityOidcSessions).where(eq(identityOidcSessions.sessionId, session.id)) : [];
        if (expired()) return reject("transaction_expired");
        if (!session || !sidecar || sidecar.accountId !== account.id || sidecar.clientId !== config.clientId || sidecar.providerRevision !== config.providerRevision ||
          session.authorizationVersion !== authorizationVersion || session.revokedAt || session.assuranceState !== "active" ||
          session.expiresAt <= now || session.idleExpiresAt <= now || session.absoluteExpiresAt <= now) return reject("session_revoked");
        if (transaction.purpose === "lease_check") {
          // A silent check can only extend liveness. New enrollment or a different IdP session requires an interactive login.
          if (sidecar.sid !== evidence.sid || sidecar.mfaStatus !== evidence.mfaStatus) {
            await revokeOidcUserSessions(tx, { userId: user.id, now, reason: "idp_assurance_changed", sessionIds: [session.id] });
            return reject("session_revoked");
          }
        } else {
          try { assertOidcStepUp(evidence, { expectedSubject: transaction.expectedSubject!, requestedAt: transaction.createdAt, now, owner }); }
          catch { return reject("assurance_required"); }
          await tx.update(identitySessions).set({ token: hashOpaqueToken(input.newSessionToken, "identity-session"),
            primaryAuthenticatedAt: evidence.primaryAt, mfaVerifiedAt: evidence.mfaAt, updatedAt: now }).where(eq(identitySessions.id, session.id));
        }
        await tx.update(identityOidcSessions).set({ sid: evidence.sid, primaryMethod: transaction.purpose === "step_up" ? evidence.primaryMethod : sidecar.primaryMethod,
          mfaStatus: evidence.mfaStatus, evidenceVerifiedAt: now, leaseStartedAt: transaction.createdAt,
          idpValidUntil: oidcLeaseDeadline(transaction.createdAt, session.expiresAt), transactionId: transaction.id }).where(eq(identityOidcSessions.sessionId, session.id));
        return { ok: true, userId: user.id, sessionId: session.id, authorizationVersion, expiresAt: session.absoluteExpiresAt, rotated: transaction.purpose === "step_up" };
      }
      if (owner && (evidence.mfaStatus !== "enrolled" || !evidence.mfaAt)) return reject("assurance_required");
      if (expired()) return reject("transaction_expired");
      const policy = resolveSessionPolicy({ kind: owner ? "owner" : "user", now, lifetimes: deps.lifetimes });
      const expiresAt = new Date(Math.min(policy.absoluteExpiresAt.getTime(), policy.idleExpiresAt.getTime()));
      const sessionId = randomUUID();
      await tx.insert(identitySessions).values({ id: sessionId, userId: user.id, token: hashOpaqueToken(input.newSessionToken, "identity-session"),
        createdAt: now, updatedAt: now, lastUsedAt: now, assuranceState: "active", primaryAuthenticatedAt: evidence.primaryAt,
        mfaVerifiedAt: evidence.mfaAt, authorizationVersion, expiresAt, ...policy,
        ipAddress: input.networkKey, userAgent: normalizeUserAgentFamily(input.userAgent) });
      await tx.insert(identityOidcSessions).values({ sessionId, userId: user.id, accountId: account.id, clientId: config.clientId,
        providerRevision: config.providerRevision, sid: evidence.sid, primaryMethod: evidence.primaryMethod, mfaStatus: evidence.mfaStatus,
        evidenceVerifiedAt: now, leaseStartedAt: transaction.createdAt, idpValidUntil: oidcLeaseDeadline(transaction.createdAt, expiresAt), transactionId: transaction.id });
      if (transaction.purpose === "owner_link") await appendAdminAuditEvent(tx, { actorUserId: user.id, actorSessionId: sessionId,
        subjectType: "identity_user", subjectId: user.id, action: "identity.oidc_owner_link_completed", outcome: "succeeded", reasonCode: "signed_browser_proof",
        beforeState: { accessRevision: user.authorizationVersion }, afterState: { accessRevision: authorizationVersion, issuer: config.issuer, subject: evidence.subject,
          clientId: config.clientId, providerRevision: config.providerRevision, mappingId: account.id },
        assurance: { method: "oidc_primary_mfa", transactionId: transaction.id }, applicationRevision: deps.applicationRevision ?? "unversioned",
        requestId: `oidc-link:${transaction.id}`, occurredAt: now });
      // Cookie survives idle sliding; database idle and lease deadlines remain authoritative.
      return { ok: true, userId: user.id, sessionId, authorizationVersion, expiresAt: policy.absoluteExpiresAt, rotated: true };
    },

    async logout(input: { logout: OidcLogout; now: Date }): Promise<{ replay: boolean; revoked: number }> {
      const { logout, now } = input;
      return db.transaction(async (tx) => {
        // With sid present, revocation is scoped to that session even if sub is also present.
        await lockOidcRevocationScope(tx, { issuer: config.issuer, clientId: config.clientId,
          ...(logout.sid ? { sid: logout.sid } : { subject: logout.subject! }) });
        if (logout.sid && logout.subject) {
          const linkedSubjects = await tx.select({ subject: identityAccounts.accountId }).from(identityOidcSessions)
            .innerJoin(identityAccounts, eq(identityAccounts.id, identityOidcSessions.accountId)).where(and(
              eq(identityAccounts.issuer, config.issuer), eq(identityAccounts.providerId, "authentik"),
              eq(identityOidcSessions.clientId, config.clientId), eq(identityOidcSessions.sid, logout.sid),
            ));
          if (linkedSubjects.some((linked) => linked.subject !== logout.subject)) throw new OidcIdentityError("invalid_response");
        }
        const [event] = await tx.insert(identityOidcLogoutEvents).values({ issuer: config.issuer, clientId: config.clientId,
          jtiHash: hashOpaqueToken(logout.jti, "oidc-logout-jti"), receivedAt: now, expiresAt: new Date(now.getTime() + 600_000) })
          .onConflictDoNothing().returning({ id: identityOidcLogoutEvents.id });
        if (!event) return { replay: true, revoked: 0 };
        const kind = logout.sid ? "sid" : "sub";
        const key = logout.sid ?? logout.subject!;
        await tx.insert(identityOidcRevocations).values({ issuer: config.issuer, clientId: config.clientId, kind, subjectKey: key,
          revokedThrough: now, receivedAt: now }).onConflictDoUpdate({
          target: [identityOidcRevocations.issuer, identityOidcRevocations.clientId, identityOidcRevocations.kind, identityOidcRevocations.subjectKey],
          set: { revokedThrough: sql`greatest(${identityOidcRevocations.revokedThrough}, ${now.toISOString()}::timestamptz)`, receivedAt: now },
        });
        const sessions = await tx.select({ userId: identitySessions.userId, sessionId: identitySessions.id })
          .from(identityOidcSessions).innerJoin(identitySessions, eq(identitySessions.id, identityOidcSessions.sessionId))
          .innerJoin(identityAccounts, eq(identityAccounts.id, identityOidcSessions.accountId))
          .where(and(eq(identityAccounts.issuer, config.issuer), eq(identityAccounts.providerId, "authentik"),
            eq(identityOidcSessions.clientId, config.clientId), isNull(identitySessions.revokedAt),
            ...(logout.sid ? [eq(identityOidcSessions.sid, logout.sid)] : [eq(identityAccounts.accountId, logout.subject!)])));
        const userIds = [...new Set(sessions.map((session) => session.userId))].sort();
        for (const userId of userIds) {
          await tx.select({ id: identityUsers.id }).from(identityUsers).where(eq(identityUsers.id, userId)).for("update");
          await revokeOidcUserSessions(tx, { userId, now, reason: "idp_logout", sessionIds: sessions.filter((session) => session.userId === userId).map((session) => session.sessionId) });
        }
        return { replay: false, revoked: sessions.length };
      });
    },

    /** Only verified protocol claims may reach this hook, even if email/assurance normalization fails. */
    async rejectTrustedIdentity(subject: string, now: Date): Promise<void> {
      if (!subject || subject.length > 255) return;
      await db.transaction(async (tx) => {
        await lockOidcRevocationScope(tx, { issuer: config.issuer, clientId: config.clientId, subject });
        const [account] = await tx.select({ userId: identityAccounts.userId }).from(identityAccounts).where(and(
          eq(identityAccounts.issuer, config.issuer), eq(identityAccounts.providerId, "authentik"), eq(identityAccounts.accountId, subject),
        )).limit(1);
        if (!account) return;
        await tx.select({ id: identityUsers.id }).from(identityUsers).where(eq(identityUsers.id, account.userId)).for("update");
        await markUnverified(tx, account.userId, now);
      });
    },
  };
}
