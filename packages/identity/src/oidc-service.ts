import type { SessionLifetimes } from "./core-identity-policy.js";
import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { identityOidcOwnerLinks, identityUsers, type PawketDatabase, type PawketTransaction } from "@pawket/database";
import { hashOpaqueToken, type EncryptionKeyring } from "@pawket/security";
import { normalizeOidcEvidence, OidcIdentityError, type OidcEvidence } from "./oidc-policy.js";
import { createOidcProtocol, type OidcProviderConfig } from "./oidc-protocol.js";
import { createOidcSessionResolver, type OidcSessionContext } from "./oidc-session.js";
import { createOidcSessionStore } from "./oidc-session-store.js";
import { createOidcTransactionRepository, type OidcTransaction, type OidcTransactionIntent } from "./oidc-transactions.js";

export function createOidcIdentityService(options: {
  db: PawketDatabase; keyring: EncryptionKeyring; config: OidcProviderConfig;
  applicationRevision?: string; lifetimes?: SessionLifetimes;
  protocol?: ReturnType<typeof createOidcProtocol>; now?: () => Date;
  completeStepUp?: (tx: PawketTransaction, input: {
    transaction: OidcTransaction; evidence: OidcEvidence; sessionId: string; userId: string; authorizationVersion: number; now: Date;
  }) => Promise<void>;
}) {
  const { config } = options;
  const now = options.now ?? (() => new Date());
  const protocol = options.protocol ?? createOidcProtocol(config);
  const transactions = createOidcTransactionRepository(options);
  const sessions = createOidcSessionStore(options);
  const resolveSession = createOidcSessionResolver({ db: options.db, provider: config, now, lifetimes: options.lifetimes });
  const opaque = () => randomBytes(32).toString("base64url");
  return {
    async authenticate(token: string, allowExpiredLease = false): Promise<OidcSessionContext | null> {
      return resolveSession({ token, now: now(), touch: true, allowExpiredLease });
    },
    async ownerLinkIntent(invitation: string): Promise<OidcTransactionIntent> {
      if (!/^[A-Za-z0-9_-]{43,128}$/u.test(invitation)) throw new OidcIdentityError("invalid_response");
      const [link] = await options.db.select({ userId: identityOidcOwnerLinks.userId, subject: identityOidcOwnerLinks.subject,
        authorizationVersion: identityUsers.authorizationVersion }).from(identityOidcOwnerLinks)
        .innerJoin(identityUsers, eq(identityUsers.id, identityOidcOwnerLinks.userId)).where(and(
          eq(identityOidcOwnerLinks.invitationHash, hashOpaqueToken(invitation, "oidc-owner-link")),
          eq(identityOidcOwnerLinks.issuer, config.issuer), eq(identityOidcOwnerLinks.clientId, config.clientId),
          eq(identityOidcOwnerLinks.providerRevision, config.providerRevision), isNull(identityOidcOwnerLinks.consumedAt),
          gt(identityOidcOwnerLinks.expiresAt, now()), eq(identityUsers.accessStatus, "active"),
        )).limit(1);
      if (!link) throw new OidcIdentityError("transaction_expired");
      return { purpose: "owner_link", ...link };
    },
    /** intent is built by the server, never copied from untrusted request JSON. */
    async begin(input: { intent: OidcTransactionIntent; returnPath: string }): Promise<{
      authorizationUrl: string; state: string; browserBinding: string;
    }> {
      if (input.intent.purpose === "step_up" && !options.completeStepUp) throw new OidcIdentityError("assurance_required");
      const startedAt = now();
      const material = protocol.newAuthorizationMaterial(); const browserBinding = opaque();
      const transaction = await transactions.start({ material, browserBinding, intent: input.intent, returnPath: input.returnPath, now: startedAt });
      try {
        const authorizationUrl = await protocol.authorizationUrl(material, input.intent.purpose);
        return { authorizationUrl, state: material.state, browserBinding };
      } catch {
        await transactions.fail(transaction.id, now());
        throw new OidcIdentityError("provider_unavailable");
      }
    },
    async callback(input: {
      url: URL; browserBinding: string; localSessionToken?: string; userAgent?: string; networkKey?: string;
    }): Promise<{ sessionToken?: string; expiresAt: Date; returnPath: string }> {
      const stateValues = input.url.searchParams.getAll("state");
      if (stateValues.length !== 1 || input.url.href.length > 8192 || input.url.searchParams.getAll("code").length > 1 ||
        input.url.searchParams.getAll("error").length > 1 || input.url.searchParams.getAll("iss").length > 1) throw new OidcIdentityError("invalid_response");
      const claimed = await transactions.claim({ state: stateValues[0]!, browserBinding: input.browserBinding, now: now() });
      try {
        const { transaction, material } = claimed;
        if (transaction.purpose === "lease_check" || transaction.purpose === "step_up") {
          const actor = input.localSessionToken ? await resolveSession({ token: input.localSessionToken, now: now(), allowExpiredLease: true }) : null;
          if (!actor || actor.userId !== transaction.expectedUserId || actor.sessionId !== transaction.expectedSessionId ||
            actor.subject !== transaction.expectedSubject || actor.authorizationVersion !== transaction.expectedAuthorizationVersion) throw new OidcIdentityError("actor_changed");
        }
        const claims = await protocol.exchange(input.url, material);
        let evidence: OidcEvidence;
        try { evidence = normalizeOidcEvidence(claims, { issuer: config.issuer, providerRevision: config.providerRevision, now: now() }); }
        catch {
          // Only claims returned by the signature-verifying protocol boundary may invalidate a known identity.
          // Do not turn an account-switch response into revocation of another account.
          if (claims.iss === config.issuer && typeof claims.sub === "string" &&
            (!transaction.expectedSubject || transaction.expectedSubject === claims.sub)) await sessions.rejectTrustedIdentity(claims.sub, now());
          throw new OidcIdentityError("invalid_response");
        }
        const sessionToken = opaque();
        const accepted = await transactions.complete({ id: transaction.id, now: now() }, async (tx, lockedTransaction) => {
          const at = now();
          const result = await sessions.accept(tx, { transaction: lockedTransaction, evidence, now: at,
            newSessionToken: sessionToken, userAgent: input.userAgent, networkKey: input.networkKey });
          if (result.ok && lockedTransaction.purpose === "step_up") {
            if (!options.completeStepUp) throw new OidcIdentityError("assurance_required");
            await options.completeStepUp(tx, { transaction: lockedTransaction, evidence, sessionId: result.sessionId,
              userId: result.userId, authorizationVersion: result.authorizationVersion, now: at });
          }
          return result;
        });
        if (!accepted.ok) throw new OidcIdentityError(accepted.code);
        return { ...(accepted.rotated ? { sessionToken } : {}), expiresAt: accepted.expiresAt, returnPath: transaction.returnPath };
      } catch (error) {
        await transactions.fail(claimed.transaction.id, now());
        if (error instanceof OidcIdentityError) throw error;
        throw new OidcIdentityError("provider_unavailable");
      }
    },
    async backchannelLogout(token: string): Promise<void> {
      const at = now(); const logout = await protocol.verifyLogout(token, at);
      await sessions.logout({ logout, now: at });
    },
    expireTransactions: (at: Date, limit?: number) => transactions.expire(at, limit),
  };
}
