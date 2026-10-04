import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  identityAccounts, identityEmailAddresses, identityOidcOwnerLinks, identityOidcSessions,
  identityRoleGrants, identitySessions, identityUsers,
} from "@pawket/database";
import { createEncryptionKeyring } from "@pawket/security";
import type { OidcEvidence } from "../src/oidc-policy.js";
import { createOidcTransactionRepository, type OidcTransactionIntent } from "../src/oidc-transactions.js";
import { createOidcSessionStore, revokeOidcLocalSessions } from "../src/oidc-session-store.js";
import { createOidcSessionResolver } from "../src/oidc-session.js";
import { oidcTestDatabase } from "./oidc-test-database.js";

const database = oidcTestDatabase();
const { db } = database;
const config = { issuer: "https://idp.example/pawket/", clientId: "test-pawket", clientSecret: "x".repeat(40),
  redirectUri: "http://localhost:3000/api/identity/oidc/callback", accountPortalUrl: "https://idp.example/if/user/", providerRevision: "v1" };
const keyring = createEncryptionKeyring({ activeKeyId: "test", keys: { test: new Uint8Array(32).fill(9) } });
const transactions = createOidcTransactionRepository({ db, keyring, config });
const store = createOidcSessionStore({ db, config, now: () => now });
const resolveSession = createOidcSessionResolver({ db, provider: config, now: () => now });
const now = new Date("2026-09-27T10:00:00Z");
const plus = (ms: number) => new Date(now.getTime() + ms);
const opaque = () => randomBytes(32).toString("base64url");
beforeAll(() => database.setup(), 30_000);
afterAll(() => database.close());
function evidence(overrides: Partial<OidcEvidence> = {}): OidcEvidence {
  const id = randomUUID();
  return { issuer: config.issuer, subject: id, sid: randomUUID(), email: `${id}@example.test`, canonicalEmail: `${id}@example.test`,
    emailVerified: true, name: "Buyer fixture", primaryAt: now, primaryMethod: "password", mfaStatus: "not_enrolled", mfaAt: null,
    providerRevision: config.providerRevision, ...overrides };
}
async function prepared(e: OidcEvidence, intent: OidcTransactionIntent = { purpose: "login" }, startedAt = now) {
  const material = { state: opaque(), nonce: opaque(), verifier: opaque() }; const browserBinding = opaque();
  const transaction = await transactions.start({ material, browserBinding, intent, returnPath: "/", now: startedAt });
  await transactions.claim({ state: material.state, browserBinding, now: startedAt });
  const sessionToken = opaque();
  return {
    transaction, sessionToken,
    async finish(at = startedAt) {
      return transactions.complete({ id: transaction.id, now: at }, (tx, transaction) => store.accept(tx, {
        transaction, evidence: e, now: at, newSessionToken: sessionToken,
      }));
    },
  };
}
async function login(e: OidcEvidence) {
  const result = await (await prepared(e)).finish();
  if (!result.ok) throw new Error(result.code);
  return result;
}
async function session(id: string) { return (await db.select().from(identitySessions).where(eq(identitySessions.id, id)))[0]!; }
async function user(id: string) { return (await db.select().from(identityUsers).where(eq(identityUsers.id, id)))[0]!; }
describe("OIDC provisioning and revocation", () => {
  test("configured lifetimes bound minting and sliding idle time without extending the absolute deadline", async () => {
    const e = evidence(); const pending = await prepared(e);
    const lifetimes = { user: { absolute: 240_000, idle: 120_000 } };
    const configured = createOidcSessionStore({ db, config, lifetimes, now: () => now });
    const result = await transactions.complete({ id: pending.transaction.id, now }, (tx, transaction) => configured.accept(tx, {
      transaction, evidence: e, now, newSessionToken: pending.sessionToken,
    }));
    if (!result.ok) throw new Error(result.code);
    expect(await session(result.sessionId)).toMatchObject({ expiresAt: plus(120_000), absoluteExpiresAt: plus(240_000) });
    const resolver = createOidcSessionResolver({ db, provider: config, lifetimes, now: () => now });
    expect(await resolver({ token: pending.sessionToken, now: plus(90_000), touch: true })).not.toBeNull();
    expect(await session(result.sessionId)).toMatchObject({ expiresAt: plus(210_000), absoluteExpiresAt: plus(240_000) });
    expect(await resolver({ token: pending.sessionToken, now: plus(240_000), touch: true, allowExpiredLease: true })).toBeNull();
  });
  test("callback waiting behind a user lock cannot mint an already expired lease", async () => {
    const e = evidence(); const actor = await login(e); const pending = await prepared(e);
    const held = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>(); let clock = now;
    const blocker = db.transaction(async (tx) => {
      await tx.select().from(identityUsers).where(eq(identityUsers.id, actor.userId)).for("update");
      held.resolve(); await release.promise;
    });
    await held.promise;
    const lateStore = createOidcSessionStore({ db, config, now: () => clock });
    const finishing = transactions.complete({ id: pending.transaction.id, now }, (tx, transaction) => lateStore.accept(tx, {
      transaction, evidence: e, now, newSessionToken: pending.sessionToken,
    }));
    clock = plus(300_000); release.resolve(); await blocker;
    expect(await finishing).toMatchObject({ ok: false, code: "transaction_expired" });
    expect(await resolveSession({ token: pending.sessionToken, now })).toBeNull();
  });
  test("local revoke-all cancels sessions and fences a login already in flight", async () => {
    const e = evidence(); const first = await login(e); const second = await login(e);
    const pending = await prepared(e, { purpose: "login" }, plus(1000));
    expect(await db.transaction((tx) => revokeOidcLocalSessions(tx, { userId: first.userId, now: plus(2000), reason: "user_requested_all" }, config))).toBe(2);
    expect((await session(first.sessionId)).revokedAt).toEqual(plus(2000));
    expect((await session(second.sessionId)).revokedAt).toEqual(plus(2000));
    expect((await user(first.userId)).authorizationVersion).toBe(2);
    expect((await pending.finish(plus(3000))).ok).toBe(false);
    expect((await (await prepared(e, { purpose: "login" }, plus(4000))).finish()).ok).toBe(true);
  });
  test("local revoke-one cannot affect another user or another session", async () => {
    const e = evidence(); const first = await login(e); const second = await login(e); const other = await login(evidence());
    expect(await db.transaction((tx) => revokeOidcLocalSessions(tx, { userId: first.userId, sessionId: other.sessionId, now, reason: "user_requested" }, config))).toBe(0);
    expect(await db.transaction((tx) => revokeOidcLocalSessions(tx, { userId: first.userId, sessionId: first.sessionId, now, reason: "user_requested" }, config))).toBe(1);
    expect((await session(second.sessionId)).revokedAt).toBeNull(); expect((await session(other.sessionId)).revokedAt).toBeNull();
  });
  test("expired lease allows only renewal context and cannot slide idle expiry", async () => {
    const pending = await prepared(evidence()); const created = await pending.finish();
    if (!created.ok) throw new Error(created.code);
    const before = await session(created.sessionId);
    expect(await resolveSession({ token: pending.sessionToken, now: plus(299_000) })).toMatchObject({ sessionId: created.sessionId, leaseRequired: false });
    expect(await resolveSession({ token: pending.sessionToken, now: plus(300_000), touch: true })).toBeNull();
    expect(await resolveSession({ token: pending.sessionToken, now: plus(300_000), allowExpiredLease: true, touch: true })).toMatchObject({ leaseRequired: true });
    expect((await session(created.sessionId)).lastUsedAt).toEqual(before.lastUsedAt);
    await db.update(identitySessions).set({ revokedAt: plus(300_000), revocationReason: "test" }).where(eq(identitySessions.id, created.sessionId));
    expect(await resolveSession({ token: pending.sessionToken, now: plus(301_000), allowExpiredLease: true })).toBeNull();
  });
  test("configured provider revision is a session boundary", async () => {
    const pending = await prepared(evidence()); await pending.finish();
    const replaced = createOidcSessionResolver({ db, provider: { ...config, providerRevision: "v2" }, now: () => now });
    expect(await replaced({ token: pending.sessionToken, now })).toBeNull();
  });
  test("idle touch preserves absolute limit and assurance timestamps", async () => {
    const pending = await prepared(evidence()); const created = await pending.finish();
    if (!created.ok) throw new Error(created.code);
    const before = await session(created.sessionId);
    await resolveSession({ token: pending.sessionToken, now: plus(120_000), touch: true });
    const after = await session(created.sessionId);
    expect(after.lastUsedAt).toEqual(plus(120_000));
    expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime() + 120_000);
    expect(after.absoluteExpiresAt).toEqual(before.absoluteExpiresAt);
    expect(after.primaryAuthenticatedAt).toEqual(before.primaryAuthenticatedAt);
  });
  test("JIT creates a verified buyer and preserves issuer/subject identity without role mapping", async () => {
    const e = evidence(); const first = await login(e); const second = await login(e);
    expect(second.userId).toBe(first.userId); expect(second.sessionId).not.toBe(first.sessionId);
    expect(await user(first.userId)).toMatchObject({ emailVerified: true, authorizationVersion: 1, twoFactorEnabled: false });
    expect(await db.select().from(identityRoleGrants).where(eq(identityRoleGrants.userId, first.userId))).toEqual([]);
    const [account] = await db.select().from(identityAccounts).where(eq(identityAccounts.userId, first.userId));
    expect(account).toMatchObject({ providerId: "authentik", issuer: config.issuer, accountId: e.subject, accessToken: null, refreshToken: null, idToken: null, password: null });
  });
  test("unverified JIT and colliding email cannot create or auto-link an account", async () => {
    const invalid = evidence({ emailVerified: false });
    expect(await (await prepared(invalid)).finish()).toEqual({ ok: false, code: "email_unverified" });
    const e = evidence(); const first = await login(e);
    expect(await (await prepared({ ...e, subject: randomUUID(), sid: randomUUID() })).finish()).toEqual({ ok: false, code: "identity_conflict" });
    expect((await user(first.userId)).authorizationVersion).toBe(1);
  });
  test("concurrent first logins resolve to one buyer and account", async () => {
    const e = evidence(); const a = await prepared(e); const b = await prepared(e);
    const results = await Promise.all([a.finish(), b.finish()]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(new Set(results.map((result) => result.ok && result.userId)).size).toBe(1);
  });
  test("verified email change preserves user ID, increments authorization, revokes existing sessions", async () => {
    const e = evidence(); const first = await login(e); const nextEmail = `${randomUUID()}@example.test`;
    const next = await login({ ...e, email: nextEmail, canonicalEmail: nextEmail });
    expect(next.userId).toBe(first.userId); expect(next.authorizationVersion).toBe(2);
    expect(await session(first.sessionId)).toMatchObject({ revocationReason: "idp_email_changed" });
    expect(await user(first.userId)).toMatchObject({ canonicalEmail: nextEmail, emailVerified: true });
    const previous = await db.select().from(identityEmailAddresses).where(and(eq(identityEmailAddresses.userId, first.userId), eq(identityEmailAddresses.canonicalEmail, e.canonicalEmail)));
    expect(previous[0]).toMatchObject({ status: "previous" });
  });
  test.each(["withdrawn", "collision"])("%s email revokes and commits the denial", async (reason) => {
    const e = evidence(); const first = await login(e); const other = evidence(); await login(other);
    const next = reason === "withdrawn" ? { ...e, emailVerified: false } : { ...e, email: other.email, canonicalEmail: other.canonicalEmail };
    const denied = await (await prepared(next)).finish();
    expect(denied).toEqual({ ok: false, code: reason === "withdrawn" ? "email_unverified" : "identity_conflict" });
    expect(await user(first.userId)).toMatchObject({ canonicalEmail: e.canonicalEmail, emailVerified: false, authorizationVersion: 2 });
    expect((await session(first.sessionId)).revokedAt).not.toBeNull();
  });
  test("silent lease renews from transaction start and preserves primary/MFA times", async () => {
    const e = evidence({ mfaStatus: "enrolled", mfaAt: now }); const first = await login(e);
    const actor = { userId: first.userId, sessionId: first.sessionId, authorizationVersion: 1, subject: e.subject };
    const pending = await prepared({ ...e, primaryAt: plus(60_000), mfaAt: plus(60_000) }, { purpose: "lease_check", actor }, plus(120_000));
    expect(await pending.finish(plus(180_000))).toMatchObject({ ok: true, rotated: false });
    const [sidecar] = await db.select().from(identityOidcSessions).where(eq(identityOidcSessions.sessionId, first.sessionId));
    expect(sidecar!.idpValidUntil).toEqual(plus(420_000));
    expect(await session(first.sessionId)).toMatchObject({ primaryAuthenticatedAt: now, mfaVerifiedAt: now });
  });
  test("slow callback cannot create a lease past the original five minutes", async () => {
    expect(await (await prepared(evidence())).finish(plus(300_000))).toEqual({ ok: false, code: "transaction_expired" });
  });
  test("changed account or authorization version cannot refresh a session", async () => {
    const e = evidence(); const first = await login(e);
    const actor = { userId: first.userId, sessionId: first.sessionId, authorizationVersion: 1, subject: e.subject };
    expect(await (await prepared({ ...e, subject: randomUUID() }, { purpose: "lease_check", actor })).finish()).toEqual({ ok: false, code: "actor_changed" });
    await db.update(identityUsers).set({ authorizationVersion: 2 }).where(eq(identityUsers.id, first.userId));
    expect(await (await prepared(e, { purpose: "lease_check", actor })).finish()).toEqual({ ok: false, code: "actor_changed" });
  });
  test("new MFA enrollment during a silent check revokes the old session", async () => {
    const e = evidence(); const first = await login(e);
    const actor = { userId: first.userId, sessionId: first.sessionId, authorizationVersion: 1, subject: e.subject };
    expect(await (await prepared({ ...e, mfaStatus: "enrolled" }, { purpose: "lease_check", actor })).finish()).toEqual({ ok: false, code: "session_revoked" });
    expect((await session(first.sessionId)).revocationReason).toBe("idp_assurance_changed");
  });
  test("step-up rotates cookie and rejects fresh tokens carrying old authentication", async () => {
    const e = evidence(); const first = await login(e); const before = await session(first.sessionId);
    const actor = { userId: first.userId, sessionId: first.sessionId, authorizationVersion: 1, subject: e.subject };
    const intent = { purpose: "step_up" as const, actor, actionClass: "receiving.create", commandDigest: "synthetic-command-digest" };
    expect(await (await prepared(e, intent, plus(60_000))).finish()).toEqual({ ok: false, code: "assurance_required" });
    const fresh = { ...e, primaryAt: plus(60_000), sid: randomUUID() };
    expect(await (await prepared(fresh, intent, plus(60_000))).finish()).toMatchObject({ ok: true, rotated: true, sessionId: first.sessionId });
    const after = await session(first.sessionId);
    expect(after.token).not.toBe(before.token); expect(after.primaryAuthenticatedAt).toEqual(plus(60_000));
  });
  test("sid logout revokes only matching client/session and replay is idempotent", async () => {
    const e = evidence(); const first = await login(e); const second = await login({ ...e, sid: randomUUID() });
    const logout = { jti: randomUUID(), issuedAt: now, sid: e.sid, subject: e.subject };
    expect(await store.logout({ logout, now: plus(1000) })).toEqual({ replay: false, revoked: 1 });
    expect(await store.logout({ logout, now: plus(2000) })).toEqual({ replay: true, revoked: 0 });
    expect((await session(first.sessionId)).revocationReason).toBe("idp_logout");
    expect((await session(second.sessionId)).revokedAt).toBeNull();
  });
  test("conflicting sid and subject cannot revoke a different identity", async () => {
    const e = evidence(); const created = await login(e);
    await expect(store.logout({ logout: { jti: randomUUID(), issuedAt: now, sid: e.sid, subject: randomUUID() }, now }))
      .rejects.toMatchObject({ code: "invalid_response" });
    expect((await session(created.sessionId)).revokedAt).toBeNull();
  });
  test("logout arriving before callback persists a fence even if no local session exists", async () => {
    const e = evidence(); const pending = await prepared(e);
    await store.logout({ logout: { jti: randomUUID(), issuedAt: now, sid: e.sid }, now });
    expect(await pending.finish()).toEqual({ ok: false, code: "session_revoked" });
  });
  test("subject logout fences old authentication; a later real login succeeds", async () => {
    const e = evidence(); const first = await login(e);
    await store.logout({ logout: { jti: randomUUID(), issuedAt: now, subject: e.subject }, now });
    expect((await session(first.sessionId)).revokedAt).not.toBeNull();
    expect(await (await prepared({ ...e, sid: randomUUID() }, { purpose: "login" }, plus(1000))).finish()).toEqual({ ok: false, code: "session_revoked" });
    expect(await (await prepared({ ...e, sid: randomUUID(), primaryAt: plus(1000) }, { purpose: "login" }, plus(1000))).finish()).toMatchObject({ ok: true, userId: first.userId });
  });
  test("callback/logout race cannot leave an active session", async () => {
    const e = evidence(); const pending = await prepared(e);
    const [result] = await Promise.all([pending.finish(), store.logout({ logout: { jti: randomUUID(), issuedAt: now, sid: e.sid }, now })]);
    if (result.ok) expect((await session(result.sessionId)).revokedAt).not.toBeNull();
    else expect(result.code).toBe("session_revoked");
  });
  test("suspended local user cannot be restored by valid IdP login", async () => {
    const e = evidence(); const first = await login(e);
    await db.update(identityUsers).set({ accessStatus: "access_suspended" }).where(eq(identityUsers.id, first.userId));
    expect(await (await prepared(e)).finish()).toEqual({ ok: false, code: "session_revoked" });
  });
  test("malformed trusted email evidence withdraws prior verification", async () => {
    const e = evidence(); const first = await login(e);
    await store.rejectTrustedIdentity(e.subject, plus(1000));
    expect((await user(first.userId)).emailVerified).toBe(false);
    expect((await session(first.sessionId)).revokedAt).not.toBeNull();
  });
  test("owner binding requires a pinned subject and fresh TOTP, retaining owner ID and roles", async () => {
    const userId = randomUUID(); const e = evidence({ mfaStatus: "enrolled", mfaAt: now });
    await db.insert(identityUsers).values({ id: userId, name: "Owner", email: e.email, canonicalEmail: e.canonicalEmail,
      emailVerified: true, emailVerifiedAt: now, emailVerificationProvenance: "password_email_challenge" });
    await db.insert(identityRoleGrants).values({ userId, role: "owner", grantSource: "bootstrap_cli" });
    const intent = { purpose: "owner_link" as const, userId, subject: e.subject, authorizationVersion: 1 };
    expect(await (await prepared(e, intent)).finish()).toEqual({ ok: false, code: "actor_changed" });
    await db.insert(identityOidcOwnerLinks).values({ userId, issuer: config.issuer, clientId: config.clientId, subject: e.subject,
      providerRevision: config.providerRevision, invitationHash: opaque(), approvedAt: now, expiresAt: plus(3_600_000) });
    expect(await (await prepared({ ...e, mfaAt: null }, intent)).finish()).toEqual({ ok: false, code: "assurance_required" });
    const result = await (await prepared(e, intent)).finish();
    expect(result).toMatchObject({ ok: true, userId, authorizationVersion: 2 });
    expect((await db.select().from(identityRoleGrants).where(eq(identityRoleGrants.userId, userId)))[0]!.state).toBe("active");
    expect(await (await prepared(e, { ...intent, authorizationVersion: 2 })).finish()).toEqual({ ok: false, code: "actor_changed" });
  });
});
