import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { identityOidcPendingCommands, identityOidcSessions, identityStepUpProofs } from "@pawket/database";
import { createEncryptionKeyring } from "@pawket/security";
import { createOidcPendingCommandRepository, type OidcPendingPayload } from "../src/oidc-pending-commands.js";
import type { OidcEvidence } from "../src/oidc-policy.js";
import { createOidcSessionStore } from "../src/oidc-session-store.js";
import { createOidcTransactionRepository, type OidcTransactionIntent } from "../src/oidc-transactions.js";
import { createOidcCommandContext } from "../src/oidc-command-context.js";
import { oidcTestDatabase } from "./oidc-test-database.js";

const database = oidcTestDatabase(); const { db } = database;
const config = { issuer: "https://idp.example/pawket/", clientId: "test-pawket", clientSecret: "x".repeat(40),
  redirectUri: "http://localhost:3000/callback", accountPortalUrl: "https://idp.example/if/user/", providerRevision: "v1" };
const keyring = createEncryptionKeyring({ activeKeyId: "test", keys: { test: new Uint8Array(32).fill(9) } });
const transactions = createOidcTransactionRepository({ db, keyring, config }); const sessions = createOidcSessionStore({ db, config, now: () => now });
const commands = createOidcPendingCommandRepository({ db, keyring, provider: config, fingerprintKey: new Uint8Array(32).fill(9),
  now: () => now,
  actionFor: (payload) => payload.method === "POST" && payload.path === "/api/v1/test/payment" ? "payments.confirm" : null });
const now = new Date("2026-09-27T10:00:00Z"); const plus = (ms: number) => new Date(now.getTime() + ms);
const opaque = () => randomBytes(32).toString("base64url");
const payload: OidcPendingPayload = { method: "POST", path: "/api/v1/test/payment", body: '{"amount":123,"privateBrief":"synthetic"}',
  idempotencyKey: "original-attempt-1", ifMatch: "4", returnPath: "/creator/orders" };
beforeAll(() => database.setup(), 30_000); afterAll(() => database.close());
async function authorize(evidence: OidcEvidence, intent: OidcTransactionIntent, returnPath = "/", at = now) {
  const material = { state: opaque(), nonce: opaque(), verifier: opaque() }; const browserBinding = opaque();
  const txn = await transactions.start({ material, browserBinding, intent, returnPath, now: at });
  await transactions.claim({ state: material.state, browserBinding, now: at });
  return transactions.complete({ id: txn.id, now: at }, async (tx, transaction) => {
    const result = await sessions.accept(tx, { transaction, evidence, now: at, newSessionToken: opaque() });
    if (!result.ok) throw new Error(result.code);
    if (intent.purpose === "step_up") await commands.completeStepUp(tx, { transaction, ...result, now: at });
    return { userId: result.userId, sessionId: result.sessionId, authorizationVersion: result.authorizationVersion, subject: evidence.subject };
  });
}
async function fixture() {
  const subject = randomUUID(); const evidence: OidcEvidence = { issuer: config.issuer, subject, sid: randomUUID(), email: `${subject}@example.test`,
    canonicalEmail: `${subject}@example.test`, emailVerified: true, name: "Fixture", primaryAt: now, primaryMethod: "password",
    mfaStatus: "not_enrolled", mfaAt: null, providerRevision: config.providerRevision };
  const actor = await authorize(evidence, { purpose: "login" });
  const pending = await commands.prepare({ actor, payload, now });
  return { actor, pending, async reauthenticate() {
    const next = await commands.intent({ actor, id: pending.id, now: plus(1000) });
    await authorize({ ...evidence, primaryAt: plus(1000) }, next.intent, next.returnPath, plus(1000));
  } };
}
describe("encrypted pending OIDC commands", () => {
  test("review readiness rejects expired, consumed and superseded authentication proofs", async () => {
    const { actor, pending, reauthenticate } = await fixture(); await reauthenticate();
    expect((await commands.review({ actor, id: pending.id, now: plus(1000) })).ready).toBe(true);
    const [command] = await db.select().from(identityOidcPendingCommands).where(eq(identityOidcPendingCommands.id, pending.id));
    await db.update(identityStepUpProofs).set({ expiresAt: plus(2000) }).where(eq(identityStepUpProofs.id, command!.proofId!));
    expect((await commands.review({ actor, id: pending.id, now: plus(2000) })).ready).toBe(false);
    await db.update(identityStepUpProofs).set({ expiresAt: plus(60_000), consumedAt: plus(1000) }).where(eq(identityStepUpProofs.id, command!.proofId!));
    expect((await commands.review({ actor, id: pending.id, now: plus(1000) })).ready).toBe(false);
    await db.update(identityStepUpProofs).set({ consumedAt: null }).where(eq(identityStepUpProofs.id, command!.proofId!));
    const other = await fixture();
    const [sidecar] = await db.select().from(identityOidcSessions).where(eq(identityOidcSessions.sessionId, other.actor.sessionId));
    await db.update(identityOidcSessions).set({ transactionId: sidecar!.transactionId }).where(eq(identityOidcSessions.sessionId, actor.sessionId));
    expect((await commands.review({ actor, id: pending.id, now: plus(1000) })).ready).toBe(false);
  });
  test("an adapter translating expired assurance to503 cannot hide the reauthentication requirement", async () => {
    const { actor } = await fixture(); const context = createOidcCommandContext({ provider: config, commands, now: () => plus(300_000) });
    await expect(context.run({ actor, payload, policy: { actionClass: "payments.confirm", fresh: true } }, async () => {
      try { await db.transaction((tx) => context.authorize(tx, actor)); } catch { return Response.json({ code: "dependency_unavailable" }, { status: 503 }); }
      throw new Error("unexpected authorization");
    })).rejects.toMatchObject({ code: "assurance_required" });
  });
  test("request context consumes only in the business transaction and preserves rollback", async () => {
    const { actor, pending, reauthenticate } = await fixture(); await reauthenticate();
    const context = createOidcCommandContext({ provider: config, commands, now: () => plus(1000) });
    const execute = (reject = false) => context.run({ actor, payload, policy: { actionClass: "payments.confirm", fresh: true }, pendingId: pending.id },
      () => db.transaction(async (tx) => { await context.authorize(tx, actor); await context.authorize(tx, actor); if (reject) throw new Error("business rollback"); }));
    await expect(execute(true)).rejects.toThrow("business rollback");
    expect((await commands.review({ actor, id: pending.id, now: plus(1000) })).ready).toBe(true);
    await execute(); await expect(execute()).rejects.toMatchObject({ code: "transaction_expired" });
    await expect(db.transaction((tx) => context.authorize(tx, actor))).rejects.toMatchObject({ code: "actor_changed" });
  });
  test("request context cannot substitute an actor or the saved payment bytes", async () => {
    const { actor, pending, reauthenticate } = await fixture(); await reauthenticate(); const other = await fixture();
    const context = createOidcCommandContext({ provider: config, commands, now: () => plus(1000) });
    await expect(context.run({ actor, payload, policy: { actionClass: "payments.confirm", fresh: true }, pendingId: pending.id },
      () => db.transaction((tx) => context.authorize(tx, other.actor)))).rejects.toMatchObject({ code: "actor_changed" });
    await expect(context.run({ actor, payload: { ...payload, body: '{"amount":999}' }, policy: { actionClass: "payments.confirm", fresh: true }, pendingId: pending.id },
      () => db.transaction((tx) => context.authorize(tx, actor)))).rejects.toMatchObject({ code: "actor_changed" });
    expect((await commands.review({ actor, id: pending.id, now: plus(1000) })).ready).toBe(true);
  });
  test("pending commands retain a full bounded commission body and enforce the concurrent per-user cap", async () => {
    const { actor } = await fixture(); const large = { ...payload, body: JSON.stringify({ brief: "x".repeat(60_000) }) };
    const saved = await commands.prepare({ actor, payload: large, now });
    expect((await commands.review({ actor, id: saved.id, now })).payload.body).toBe(large.body);
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => commands.prepare({ actor, payload, now })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(8);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(2);
  });
  test("callback marks ready without running a mutation; confirmation preserves bytes and key", async () => {
    const { actor, pending, reauthenticate } = await fixture();
    const [stored] = await db.select().from(identityOidcPendingCommands).where(eq(identityOidcPendingCommands.id, pending.id));
    expect(JSON.stringify(stored)).not.toContain("privateBrief");
    expect(await commands.review({ actor, id: pending.id, now })).toMatchObject({ ready: false, payload });
    await expect(db.transaction((tx) => commands.consume(tx, { actor, id: pending.id, now }, async () => "bad")))
      .rejects.toMatchObject({ code: "assurance_required" });
    await reauthenticate();
    expect(await commands.review({ actor, id: pending.id, now: plus(1000) })).toMatchObject({ ready: true, payload });
    const result = await db.transaction((tx) => commands.consume(tx, { actor, id: pending.id, now: plus(1000) }, async (saved) => saved));
    expect(result).toEqual(payload);
    const [consumed] = await db.select().from(identityOidcPendingCommands).where(eq(identityOidcPendingCommands.id, pending.id));
    expect(consumed?.payloadEnvelope).toBeNull(); expect(consumed?.consumedAt).toEqual(plus(1000));
    await expect(commands.review({ actor, id: pending.id, now: plus(1000) })).rejects.toMatchObject({ code: "transaction_expired" });
  });
  test("failed domain work rolls back proof and pending command together", async () => {
    const { actor, pending, reauthenticate } = await fixture(); await reauthenticate();
    await expect(db.transaction((tx) => commands.consume(tx, { actor, id: pending.id, now: plus(1000) }, async () => { throw new Error("domain rejected"); })))
      .rejects.toThrow("domain rejected");
    expect(await db.transaction((tx) => commands.consume(tx, { actor, id: pending.id, now: plus(1000) }, async () => "accepted"))).toBe("accepted");
  });
  test("cross-actor access, expiry, and ciphertext transplantation are rejected", async () => {
    const first = await fixture(); const second = await fixture();
    await expect(commands.review({ actor: second.actor, id: first.pending.id, now })).rejects.toMatchObject({ code: "transaction_expired" });
    await expect(commands.review({ actor: first.actor, id: first.pending.id, now: plus(600_000) })).rejects.toMatchObject({ code: "transaction_expired" });
    const [other] = await db.select().from(identityOidcPendingCommands).where(eq(identityOidcPendingCommands.id, second.pending.id));
    await db.update(identityOidcPendingCommands).set({ payloadEnvelope: other!.payloadEnvelope }).where(eq(identityOidcPendingCommands.id, first.pending.id));
    await expect(commands.review({ actor: first.actor, id: first.pending.id, now })).rejects.toMatchObject({ code: "invalid_response" });
  });
  test("only server-registered local commands can be preserved", async () => {
    const { actor } = await fixture();
    for (const path of ["https://example.test/", "/api/v1/auth/start", "/api/v1/unregistered", "/api/v1/test/payment?amount=1"]) {
      await expect(commands.prepare({ actor, payload: { ...payload, path }, now })).rejects.toMatchObject({ code: "invalid_response" });
    }
    await expect(commands.prepare({ actor, payload: { ...payload, body: "x".repeat(65_537) }, now })).rejects.toMatchObject({ code: "invalid_response" });
  });
  test("bounded cleanup erases expired pending payloads while keeping their audit row", async () => {
    const first = await fixture(); const second = await fixture();
    expect(await transactions.expire(plus(600_000), 1)).toBe(1);
    const rows = await db.select().from(identityOidcPendingCommands);
    const cleanupRows = rows.filter((row) => new Set<string>([first.pending.id, second.pending.id]).has(row.id));
    // Other fixtures may have earlier expired commands; process bounded batches.
    while (await transactions.expire(plus(600_000), 1)) { /* each transaction locks at most one row per table */ }
    for (const item of cleanupRows) {
      const [stored] = await db.select().from(identityOidcPendingCommands).where(eq(identityOidcPendingCommands.id, item.id));
      expect(stored).toMatchObject({ id: item.id, payloadEnvelope: null, consumedAt: plus(600_000) });
    }
  });
});
