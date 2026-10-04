import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { identityOidcSessions, identityRoleGrants, identitySessions, identityUsers } from "@pawket/database";
import { createEncryptionKeyring, createLookupHmac } from "@pawket/security";
import { createOidcAssurancePort } from "../src/oidc-assurance-port.js";
import { createOidcProofRepository } from "../src/oidc-proofs.js";
import { createOidcSessionStore } from "../src/oidc-session-store.js";
import { createOidcTransactionRepository } from "../src/oidc-transactions.js";
import { oidcTestDatabase } from "./oidc-test-database.js";

const database = oidcTestDatabase(); const { db } = database;
const config = { issuer: "https://idp.example/pawket/", clientId: "test-pawket", clientSecret: "x".repeat(40),
  redirectUri: "http://localhost:3000/callback", accountPortalUrl: "https://idp.example/if/user/", providerRevision: "v1" };
const keyring = createEncryptionKeyring({ activeKeyId: "test", keys: { test: new Uint8Array(32).fill(9) } });
const transactions = createOidcTransactionRepository({ db, keyring, config });
const sessions = createOidcSessionStore({ db, config, now: () => now });
const assurance = createOidcAssurancePort(config, () => now); const proofs = createOidcProofRepository(config, () => now);
const now = new Date("2026-09-27T10:00:00Z"); const plus = (ms: number) => new Date(now.getTime() + ms);
const digest = (value: string) => createLookupHmac({ value, context: "oidc-command", key: new Uint8Array(32).fill(9) });
const opaque = () => randomBytes(32).toString("base64url");
beforeAll(() => database.setup(), 30_000); afterAll(() => database.close());
async function fixture(totp = false) {
  const subject = randomUUID(); const material = { state: opaque(), nonce: opaque(), verifier: opaque() }; const browserBinding = opaque();
  const transaction = await transactions.start({ material, browserBinding, intent: { purpose: "login" }, returnPath: "/", now });
  await transactions.claim({ state: material.state, browserBinding, now });
  const result = await transactions.complete({ id: transaction.id, now }, (tx, transaction) => sessions.accept(tx, { transaction, now,
    newSessionToken: opaque(), evidence: { issuer: config.issuer, subject, sid: randomUUID(), email: `${subject}@example.test`,
      canonicalEmail: `${subject}@example.test`, emailVerified: true, name: "Fixture", primaryAt: now, primaryMethod: "password",
      mfaStatus: totp ? "enrolled" : "not_enrolled", mfaAt: totp ? now : null, providerRevision: config.providerRevision } }));
  if (!result.ok) throw new Error(result.code);
  return { userId: result.userId, sessionId: result.sessionId, actionClass: "payments.confirm", commandDigest: digest(subject), now };
}

describe("OIDC business assurance and command proofs", () => {
  test("configured shorter primary and TOTP windows bound both issue and consume", async () => {
    const actor = await fixture(true);
    const policy = { primaryFreshMs: 30_000, totpFreshMs: 10_000 };
    const proof = await db.transaction((tx) => proofs.create(tx, { ...actor, ...policy }));
    expect(proof.expiresAt).toEqual(plus(10_000));
    expect(await db.transaction((tx) => proofs.usable(tx, { ...actor, ...policy, proofId: proof.id, now: plus(10_000) }))).toBe(false);
    expect(await db.transaction((tx) => proofs.check(tx, { ...actor, ...policy, now: plus(10_000) }))).toBe(false);
    expect(await db.transaction((tx) => proofs.consume(tx, { ...actor, proofId: proof.id, now: plus(10_000) }))).toBe(false);
  });
  test("lease is a business commit fence and bounds proof lifetime", async () => {
    const actor = await fixture();
    const proof = await db.transaction((tx) => proofs.create(tx, actor));
    expect(proof.expiresAt).toEqual(plus(300_000));
    expect(await db.transaction((tx) => assurance.read(tx, actor, plus(300_000)))).toBeNull();
    expect(await db.transaction((tx) => proofs.consume(tx, { ...actor, proofId: proof.id, now: plus(300_000) }))).toBe(false);
  });
  test("lease expiring behind a session lock rejects the original request timestamp", async () => {
    const actor = await fixture();
    const held = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    let clock = now;
    const blocker = db.transaction(async (tx) => {
      await tx.select().from(identitySessions).where(eq(identitySessions.id, actor.sessionId)).for("update");
      held.resolve(); await release.promise;
    });
    await held.promise;
    const pending = db.transaction((tx) => createOidcAssurancePort(config, () => clock).read(tx, actor, now));
    clock = plus(300_000); release.resolve(); await blocker;
    expect(await pending).toBeNull();
    await expect(db.transaction((tx) => createOidcProofRepository(config, () => clock).create(tx, actor)))
      .rejects.toMatchObject({ code: "RECENT_AUTH_REQUIRED" });
  });
  test("payload, user, session, and action substitution are rejected", async () => {
    const actor = await fixture(); const other = await fixture(); const proof = await db.transaction((tx) => proofs.create(tx, actor));
    for (const changed of [{ commandDigest: digest("changed") }, { actionClass: "payments.refund" }, { userId: other.userId }, { sessionId: other.sessionId }]) {
      expect(await db.transaction((tx) => proofs.consume(tx, { ...actor, ...changed, proofId: proof.id }))).toBe(false);
    }
    expect(await db.transaction((tx) => proofs.consume(tx, { ...actor, proofId: proof.id }))).toBe(true);
  });
  test("proof is consumed exactly once under concurrency", async () => {
    const actor = await fixture(); const proof = await db.transaction((tx) => proofs.create(tx, actor));
    const results = await Promise.all(Array.from({ length: 5 }, () => db.transaction((tx) => proofs.consume(tx, { ...actor, proofId: proof.id }))));
    expect(results.filter(Boolean)).toHaveLength(1);
  });
  test("business rollback also rolls back proof consumption", async () => {
    const actor = await fixture(); const proof = await db.transaction((tx) => proofs.create(tx, actor));
    await expect(db.transaction(async (tx) => { expect(await proofs.consume(tx, { ...actor, proofId: proof.id })).toBe(true); throw new Error("business rejected"); }))
      .rejects.toThrow("business rejected");
    expect(await db.transaction((tx) => proofs.consume(tx, { ...actor, proofId: proof.id }))).toBe(true);
  });
  test("authorization version change and provider revision invalidate proofs", async () => {
    const actor = await fixture(); const proof = await db.transaction((tx) => proofs.create(tx, actor));
    expect(await db.transaction((tx) => createOidcProofRepository({ ...config, providerRevision: "v2" }, () => now).consume(tx, { ...actor, proofId: proof.id }))).toBe(false);
    await db.update(identityUsers).set({ authorizationVersion: 2 }).where(eq(identityUsers.id, actor.userId));
    expect(await db.transaction((tx) => proofs.consume(tx, { ...actor, proofId: proof.id }))).toBe(false);
  });
  test("unknown enrollment, future MFA, or revoked session do not yield assurance", async () => {
    const actor = await fixture(true);
    await db.update(identityOidcSessions).set({ totpStatus: "unknown" }).where(eq(identityOidcSessions.sessionId, actor.sessionId));
    expect(await db.transaction((tx) => assurance.read(tx, actor, now))).toBeNull();
    await db.update(identityOidcSessions).set({ totpStatus: "enrolled" }).where(eq(identityOidcSessions.sessionId, actor.sessionId));
    await db.update(identitySessions).set({ mfaVerifiedAt: plus(1000) }).where(eq(identitySessions.id, actor.sessionId));
    await expect(db.transaction((tx) => proofs.create(tx, actor))).rejects.toMatchObject({ code: "RECENT_AUTH_REQUIRED" });
    await db.update(identitySessions).set({ revokedAt: now, revocationReason: "test" }).where(eq(identitySessions.id, actor.sessionId));
    expect(await db.transaction((tx) => assurance.read(tx, actor, now))).toBeNull();
  });
  test("owner role is local and requires real TOTP evidence without a local TOTP row", async () => {
    const actor = { ...await fixture(true), actionClass: "owner.payment_confirm" };
    expect(await db.transaction((tx) => assurance.authorizeOwner(tx, actor, now))).toBe(false);
    await db.insert(identityRoleGrants).values({ userId: actor.userId, role: "owner", state: "active", grantSource: "bootstrap_cli" });
    expect(await db.transaction((tx) => assurance.authorizeOwner(tx, actor, now))).toBe(true);
    const proof = await db.transaction((tx) => proofs.create(tx, actor));
    await db.update(identityRoleGrants).set({ state: "revoked", revokedAt: now }).where(eq(identityRoleGrants.userId, actor.userId));
    expect(await db.transaction((tx) => proofs.consume(tx, { ...actor, proofId: proof.id }))).toBe(false);
  });
  test("a deadline cannot exceed either command expiry or evidence freshness", async () => {
    const actor = await fixture(true);
    const proof = await db.transaction((tx) => proofs.create(tx, { ...actor, deadline: plus(15_000) }));
    expect(proof.expiresAt).toEqual(plus(15_000));
    await expect(db.transaction((tx) => proofs.create(tx, { ...actor, deadline: now }))).rejects.toMatchObject({ code: "RECENT_AUTH_REQUIRED" });
  });
});
