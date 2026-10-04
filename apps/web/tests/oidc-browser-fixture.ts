import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createDatabase, identityAccounts, identityOidcPendingCommands, identityOidcSessions, identitySessions, identityUsers, type PawketDatabase } from "@pawket/database";
import { createOidcPendingCommandRepository, createOidcSessionStore, createOidcTransactionRepository, hashSessionToken } from "@pawket/identity";
import { createEncryptionKeyring } from "@pawket/security";
import { browserDatabaseUrl, assertIncrementThreeBrowserDatabaseName } from "./increment-three-database";
import { attachSyntheticOidcSession, syntheticOidcProvider } from "./oidc-test-support";
import { oidcCommand } from "../src/platform/oidc-command-registry";

const keyring = createEncryptionKeyring({ activeKeyId: "playwright-pii-v1", keys: { "playwright-pii-v1": new Uint8Array(32).fill(1) } });
const config = { ...syntheticOidcProvider, clientSecret: "browser-synthetic-only-0000000000000000", redirectUri: "http://127.0.0.1:4177/api/v1/auth/oidc/callback", accountPortalUrl: "https://idp.example.invalid/if/user/" };
const opaque = () => randomBytes(32).toString("base64url");
function mfaStatus(value: string): "enrolled" | "not_enrolled" | "unknown" {
  if (value === "enrolled" || value === "not_enrolled" || value === "unknown") return value;
  throw new Error("Invalid synthetic MFA evidence");
}

/** Explicit test composition only: no application route or production switch. */
export async function refreshBrowserSession(token: string) {
  assertIncrementThreeBrowserDatabaseName(new URL(browserDatabaseUrl).pathname.slice(1));
  const database = createDatabase(browserDatabaseUrl); const now = new Date();
  try {
    const [session] = await database.db.select().from(identitySessions).where(eq(identitySessions.token, hashSessionToken(token)));
    if (!session) throw new Error("Unknown synthetic browser session");
    const [sidecar] = await database.db.select().from(identityOidcSessions).where(eq(identityOidcSessions.sessionId, session.id));
    if (!sidecar) throw new Error("Missing synthetic OIDC evidence");
    await database.db.transaction(async (tx) => {
      await tx.update(identitySessions).set({ primaryAuthenticatedAt: now, mfaVerifiedAt: sidecar.mfaStatus === "enrolled" ? now : null,
        expiresAt: new Date(now.getTime() + 1_800_000), idleExpiresAt: new Date(now.getTime() + 1_800_000),
        absoluteExpiresAt: new Date(now.getTime() + 3_600_000), revokedAt: null, updatedAt: now }).where(eq(identitySessions.id, session.id));
      await attachSyntheticOidcSession(tx, { userId: session.userId, sessionId: session.id, now, mfaStatus: mfaStatus(sidecar.mfaStatus) });
    });
  } finally { await database.close(); }
}

/** Supply synthetic IdP evidence to the real callback transaction and proof ports.
 * Browser tests still exercise persistence, review, explicit confirmation and the
 * business transaction. Real signature/provider conformance has separate gates. */
export async function completeSyntheticPendingAuthentication(db: PawketDatabase, pendingId: string) {
  assertIncrementThreeBrowserDatabaseName(new URL(browserDatabaseUrl).pathname.slice(1));
  const [pending] = await db.select().from(identityOidcPendingCommands).where(eq(identityOidcPendingCommands.id, pendingId));
  if (!pending) throw new Error("Synthetic pending command missing");
  const [user] = await db.select().from(identityUsers).where(eq(identityUsers.id, pending.userId));
  const [account] = await db.select().from(identityAccounts).where(and(eq(identityAccounts.userId, pending.userId), eq(identityAccounts.providerId, "authentik")));
  const [sidecar] = await db.select().from(identityOidcSessions).where(eq(identityOidcSessions.sessionId, pending.sessionId));
  if (!user || !account || !sidecar) throw new Error("Synthetic actor missing");
  const commands = createOidcPendingCommandRepository({ db, keyring, provider: config, fingerprintKey: new Uint8Array(32).fill(2), actionFor: (payload) => oidcCommand(payload)?.policy.actionClass ?? null });
  const actor = { userId: user.id, sessionId: pending.sessionId, authorizationVersion: user.authorizationVersion, subject: account.accountId };
  const now = new Date(); const intent = await commands.intent({ id: pendingId, actor, now });
  const transactions = createOidcTransactionRepository({ db, keyring, config });
  const sessions = createOidcSessionStore({ db, config });
  const material = { state: opaque(), nonce: opaque(), verifier: opaque() }; const browserBinding = opaque();
  const transaction = await transactions.start({ material, browserBinding, ...intent, now });
  await transactions.claim({ state: material.state, browserBinding, now });
  const sessionToken = opaque();
  await transactions.complete({ id: transaction.id, now }, async (tx, claimed) => {
    const result = await sessions.accept(tx, { transaction: claimed, now, newSessionToken: sessionToken, evidence: {
      issuer: config.issuer, subject: account.accountId, sid: sidecar.sid, email: user.email, canonicalEmail: user.canonicalEmail,
      emailVerified: true, name: user.name, primaryAt: now, primaryMethod: "password", mfaStatus: mfaStatus(sidecar.mfaStatus),
      mfaAt: sidecar.mfaStatus === "enrolled" ? now : null, providerRevision: config.providerRevision,
    } });
    if (!result.ok) throw new Error(result.code);
    await commands.completeStepUp(tx, { transaction: claimed, ...result, now });
  });
  return { ...await commands.review({ id: pendingId, actor, now: new Date() }), sessionToken };
}

export async function restoreBrowserSessionToken(db: PawketDatabase, sessionId: string, token: string) {
  assertIncrementThreeBrowserDatabaseName(new URL(browserDatabaseUrl).pathname.slice(1));
  await db.update(identitySessions).set({ token: hashSessionToken(token) }).where(eq(identitySessions.id, sessionId));
}
