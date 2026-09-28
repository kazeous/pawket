import { createOidcCommandContext, createOidcPendingCommandRepository, type OidcPendingPayload } from "@pawket/identity";
import { createEncryptionKeyring } from "@pawket/security";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { identityUsers, identityAccounts, identityOidcSessions, identityOidcTransactions, type PawketDatabase, type PawketTransaction } from "@pawket/database";

export const syntheticOidcProvider = { issuer: "https://idp.example.invalid/application/o/pawket/", clientId: "pawket-synthetic", providerRevision: "synthetic-v1" };

/** Synthetic provider evidence for domain tests; production never imports this fixture. */
export async function attachSyntheticOidcSession(db: PawketDatabase | PawketTransaction, input: {
  userId: string; sessionId: string; now: Date; totpStatus?: "enrolled" | "not_enrolled" | "unknown";
}) {
  let [account] = await db.select().from(identityAccounts).where(and(eq(identityAccounts.userId, input.userId),
    eq(identityAccounts.providerId, "authentik"), eq(identityAccounts.issuer, syntheticOidcProvider.issuer)));
  if (!account) [account] = await db.insert(identityAccounts).values({ id: randomUUID(), userId: input.userId,
    accountId: randomUUID(), providerId: "authentik", issuer: syntheticOidcProvider.issuer, createdAt: input.now, updatedAt: input.now }).returning();
  const transactionId = randomUUID(); const expiresAt = new Date(input.now.getTime() + 300_000);
  await db.insert(identityOidcTransactions).values({ id: transactionId, ...syntheticOidcProvider, purpose: "login", status: "consumed",
    stateHash: randomUUID(), browserBindingHash: randomUUID(), nonce: randomUUID(), verifierEnvelope: null,
    returnPath: "/", createdAt: input.now, expiresAt, claimedAt: input.now, completedAt: input.now });
  const sidecar = { sessionId: input.sessionId, userId: input.userId, accountId: account!.id,
    clientId: syntheticOidcProvider.clientId, providerRevision: syntheticOidcProvider.providerRevision,
    sid: randomUUID(), primaryMethod: "password", totpStatus: input.totpStatus ?? "not_enrolled",
    evidenceVerifiedAt: input.now, leaseStartedAt: input.now, idpValidUntil: expiresAt, transactionId };
  await db.insert(identityOidcSessions).values(sidecar).onConflictDoUpdate({ target: identityOidcSessions.sessionId, set: sidecar });
}

export function syntheticOidcCommandHarness(db: PawketDatabase) {
  const key = new Uint8Array(32).fill(29);
  const keyring = createEncryptionKeyring({ activeKeyId: "synthetic", keys: { synthetic: key } });
  const commands = createOidcPendingCommandRepository({ db, keyring, fingerprintKey: key, provider: syntheticOidcProvider, actionFor: () => "owner.tip_policy_update" });
  const context = createOidcCommandContext({ provider: syntheticOidcProvider, commands });
  return { context, async run<T>(actor: { userId: string; sessionId: string }, payload: OidcPendingPayload, execute: () => Promise<T>) {
    const [account] = await db.select().from(identityAccounts).where(and(eq(identityAccounts.userId, actor.userId), eq(identityAccounts.providerId, "authentik")));
    const [user] = await db.select().from(identityUsers).where(eq(identityUsers.id, actor.userId));
    if (!account || !user) throw new Error("Synthetic OIDC actor missing");
    return context.run({ actor: { ...actor, authorizationVersion: user.authorizationVersion, subject: account.accountId }, payload, policy: { actionClass: "owner.tip_policy_update", fresh: true } }, execute);
  } };
}
