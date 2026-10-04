import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { identityOidcPendingCommands, paymentsReceivingAccountOnboarding } from "@pawket/database";
import { createEncryptionKeyring } from "@pawket/security";
import { createReceivingAccountService } from "@pawket/payments";
import { createOidcCommandContext, createOidcPendingCommandRepository, createOidcProofRepository,
  createOidcSessionStore, createOidcTransactionRepository } from "@pawket/identity";
import { oidcTestDatabase } from "../../../packages/identity/tests/oidc-test-database.js";
import { oidcCommand } from "../src/platform/oidc-command-registry.js";

const database = oidcTestDatabase(); const { db } = database;
const now = new Date("2026-09-27T10:00:00Z");
const config = { issuer: "https://idp.example/pawket/", clientId: "synthetic-pawket", clientSecret: "x".repeat(40),
  redirectUri: "http://localhost:3000/callback", accountPortalUrl: "https://idp.example/if/user/", providerRevision: "v1" };
const key = new Uint8Array(32).fill(9); const keyring = createEncryptionKeyring({ activeKeyId: "test", keys: { test: key } });
const transactions = createOidcTransactionRepository({ db, keyring, config });
const sessions = createOidcSessionStore({ db, config, now: () => now });
const commands = createOidcPendingCommandRepository({ db, keyring, fingerprintKey: key, provider: config, now: () => now,
  actionFor: (payload) => oidcCommand(payload)?.policy.actionClass ?? null });
const opaque = () => randomBytes(32).toString("base64url");
beforeAll(() => database.setup(), 30_000); afterAll(() => database.close());
async function fixture() {
  const subject = randomUUID(); const material = { state: opaque(), nonce: opaque(), verifier: opaque() }; const browserBinding = opaque();
  const transaction = await transactions.start({ material, browserBinding, intent: { purpose: "login" }, returnPath: "/", now });
  await transactions.claim({ state: material.state, browserBinding, now });
  const accepted = await transactions.complete({ id: transaction.id, now }, (tx, transaction) => sessions.accept(tx, { transaction, now, newSessionToken: opaque(),
    evidence: { issuer: config.issuer, subject, sid: randomUUID(), email: `${subject}@example.test`, canonicalEmail: `${subject}@example.test`,
      emailVerified: true, name: "Synthetic", primaryAt: now, primaryMethod: "password", mfaStatus: "not_enrolled", mfaAt: null, providerRevision: "v1" } }));
  if (!accepted.ok) throw new Error(accepted.code);
  const actor = { userId: accepted.userId, sessionId: accepted.sessionId, authorizationVersion: accepted.authorizationVersion, subject };
  const body = { bankBin: "000000", accountNumber: "1234567890", accountHolderLabel: "SYNTHETIC ACCOUNT" };
  const payload = { method: "POST" as const, path: "/api/v1/creator-application/receiving-account", body: JSON.stringify(body),
    idempotencyKey: randomUUID(), ifMatch: null, returnPath: "/creator/apply" };
  const policy = oidcCommand(payload)!.policy;
  const context = (at = now) => createOidcCommandContext({ provider: config, commands, now: () => at });
  function propose(commandContext: ReturnType<typeof context>) {
    const service = createReceivingAccountService({ db, keyring, lookupHmacKey: key, supportedBanks: { "000000": "Synthetic Bank" }, now: () => now,
      authorizeCommand: commandContext.authorize });
    return service.propose({ ...body, applicantUserId: actor.userId, sessionId: actor.sessionId, primaryAuthenticatedAt: now, idempotencyKey: payload.idempotencyKey });
  }
  return { actor, payload, policy, context, propose };
}
describe("receiving-account OIDC command composition", () => {
  test("fresh request and replay authorize inside the account transaction", async () => {
    const f = await fixture(); const context = f.context();
    const run = () => context.run({ actor: f.actor, payload: f.payload, policy: f.policy }, () => f.propose(context));
    const first = await run(); expect(await run()).toEqual(first);
    const rows = await db.select().from(paymentsReceivingAccountOnboarding).where(eq(paymentsReceivingAccountOnboarding.applicantUserId, f.actor.userId));
    expect(rows).toHaveLength(1); expect(JSON.stringify(rows)).not.toContain("1234567890");
  });
  test("expired OIDC evidence rolls back a new account and cannot replay existing account data", async () => {
    const f = await fixture(); const expired = f.context(new Date(now.getTime() + 300_000));
    await expect(expired.run({ actor: f.actor, payload: f.payload, policy: f.policy }, () => f.propose(expired))).rejects.toMatchObject({ code: "assurance_required" });
    expect(await db.select().from(paymentsReceivingAccountOnboarding).where(eq(paymentsReceivingAccountOnboarding.applicantUserId, f.actor.userId))).toHaveLength(0);
    const fresh = f.context(); await fresh.run({ actor: f.actor, payload: f.payload, policy: f.policy }, () => f.propose(fresh));
    await expect(expired.run({ actor: f.actor, payload: f.payload, policy: f.policy }, () => f.propose(expired))).rejects.toMatchObject({ code: "assurance_required" });
  });
  test("explicit pending confirmation consumes its proof and saved body atomically", async () => {
    const f = await fixture(); const pending = await commands.prepare({ actor: f.actor, payload: f.payload, now });
    // Synthetic readiness fixture; the real callback path is covered by repository tests.
    await db.transaction(async (tx) => {
      const proof = await createOidcProofRepository(config, () => now).create(tx, { ...f.actor, actionClass: f.policy.actionClass, commandDigest: commands.digest(f.payload), now });
      await tx.update(identityOidcPendingCommands).set({ proofId: proof.id }).where(eq(identityOidcPendingCommands.id, pending.id));
    });
    const context = f.context();
    await context.run({ actor: f.actor, payload: f.payload, policy: f.policy, pendingId: pending.id }, () => f.propose(context));
    const [stored] = await db.select().from(identityOidcPendingCommands).where(eq(identityOidcPendingCommands.id, pending.id));
    expect(stored).toMatchObject({ payloadEnvelope: null, consumedAt: now });
    await expect(context.run({ actor: f.actor, payload: f.payload, policy: f.policy, pendingId: pending.id }, () => f.propose(context))).rejects.toMatchObject({ code: "transaction_expired" });
  });
});
