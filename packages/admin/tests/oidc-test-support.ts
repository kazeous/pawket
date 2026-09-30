import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { identityAccounts, identityOidcSessions, identityOidcTransactions, type PawketDatabase, type PawketTransaction } from "@pawket/database";

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
  await db.insert(identityOidcSessions).values({ sessionId: input.sessionId, userId: input.userId, accountId: account!.id,
    clientId: syntheticOidcProvider.clientId, providerRevision: syntheticOidcProvider.providerRevision,
    sid: randomUUID(), primaryMethod: "password", totpStatus: input.totpStatus ?? "not_enrolled",
    evidenceVerifiedAt: input.now, leaseStartedAt: input.now, idpValidUntil: expiresAt, transactionId });
}
