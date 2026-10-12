import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  creatorPages, identityCreatorCapabilities, identityCreatorCapabilityEvents, identityOidcPendingCommands,
  identityRoleGrants, identitySessions, identityStepUpProofs, identityUsers, systemOutbox, type PawketTransaction,
} from "@pawket/database";
import { createEncryptionKeyring, encryptSensitiveField } from "@pawket/security";
import { insertTestPenalty, penaltyAt, seedPenaltySubject } from "./enforcement-test-fixture.js";
import { createIdentityEnforcementPort } from "../src/enforcement-port.js";
import { createCreatorStandingPort } from "../src/creator-standing-port.js";
import { createOidcAssurancePort } from "../src/oidc-assurance-port.js";
import { createOidcSessionResolver } from "../src/oidc-session.js";
import { createOidcSessionStore } from "../src/oidc-session-store.js";
import { createOidcTransactionRepository } from "../src/oidc-transactions.js";
import { oidcTestDatabase } from "./oidc-test-database.js";

const database = oidcTestDatabase(); const { db, client } = database;
beforeAll(() => database.setup(), 30_000); afterAll(() => database.close());
const config = { issuer: "https://idp.example/pawket/", clientId: "test-pawket", clientSecret: "x".repeat(40),
  redirectUri: "http://localhost:3000/callback", accountPortalUrl: "https://idp.example/if/user/", providerRevision: "v1" };
const keyring = createEncryptionKeyring({ activeKeyId: "test", keys: { test: new Uint8Array(32).fill(9) } });
const transactions = createOidcTransactionRepository({ db, keyring, config });
const sessions = createOidcSessionStore({ db, config, now: () => penaltyAt });
const assurance = createOidcAssurancePort(config, () => penaltyAt);
const resolveSession = createOidcSessionResolver({ db, provider: config, now: () => penaltyAt });
const opaque = () => randomBytes(32).toString("base64url");
const port = createIdentityEnforcementPort({
  async clearPublishedHeadForSuspension(tx, input) {
    const [page] = await tx.select().from(creatorPages).where(eq(creatorPages.userId, input.creatorUserId)).for("update");
    if (!page) return { pageId: null, previousPublishedRevisionId: null };
    await tx.update(creatorPages).set({ publishedRevisionId: null, updatedAt: input.occurredAt }).where(eq(creatorPages.id, page.id));
    return { pageId: page.id, previousPublishedRevisionId: page.publishedRevisionId };
  },
});
// The caller takes the commission fence before lockSubject, as required by the port contract.
async function lock(tx: PawketTransaction, userId: string) {
  const { sql } = await import("drizzle-orm");
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`commissions:creator:${userId}`}, 0))`);
  return port.lockSubject(tx, userId);
}
async function login(subject = randomUUID()) {
  const material = { state: opaque(), nonce: opaque(), verifier: opaque() }; const browserBinding = opaque(); const token = opaque();
  const transaction = await transactions.start({ material, browserBinding, intent: { purpose: "login" }, returnPath: "/", now: penaltyAt });
  await transactions.claim({ state: material.state, browserBinding, now: penaltyAt });
  const result = await transactions.complete({ id: transaction.id, now: penaltyAt }, (tx, transaction) => sessions.accept(tx, {
    transaction, now: penaltyAt, newSessionToken: token, evidence: { issuer: config.issuer, subject, sid: randomUUID(),
      email: `${subject}@example.test`, canonicalEmail: `${subject}@example.test`, emailVerified: true, name: "Fixture",
      primaryAt: penaltyAt, primaryMethod: "password", mfaStatus: "not_enrolled", mfaAt: null, providerRevision: config.providerRevision },
  }));
  if (!result.ok) throw new Error(result.code);
  return { userId: result.userId, sessionId: result.sessionId, token, subject };
}
describe("identity enforcement port", () => {
  test("setAccountAccess access_suspended bumps authorization version and revokes all sessions", async () => {
    const first = await login(); const second = await login(first.subject); const fixture = await seedPenaltySubject(client, first.userId);
    const penaltyId = await insertTestPenalty(client, fixture, { target: "account" });
    const proofId = randomUUID(); const pendingId = randomUUID();
    await db.insert(identityStepUpProofs).values({ id: proofId, userId: first.userId, sessionId: first.sessionId,
      actionClass: "trust.report_submit", assuranceMethod: "primary", issuedAt: penaltyAt, expiresAt: new Date(penaltyAt.getTime() + 300_000) });
    await db.insert(identityOidcPendingCommands).values({ id: pendingId, userId: first.userId, sessionId: second.sessionId,
      authorizationVersion: 1, actionClass: "trust.report_submit", commandDigest: "test", createdAt: penaltyAt,
      expiresAt: new Date(penaltyAt.getTime() + 300_000), payloadEnvelope: encryptSensitiveField({ plaintext: "{}", keyring,
        binding: { recordType: "identity_oidc_pending_command", recordId: pendingId, fieldName: "payload" } }) });
    expect(await resolveSession({ token: first.token, now: penaltyAt })).not.toBeNull();
    expect(await db.transaction((tx) => assurance.getTipSessionAssurance(tx, first, penaltyAt))).not.toBeNull();
    await db.transaction(async (tx) => {
      await lock(tx, first.userId);
      expect(await port.setAccountAccess(tx, { userId: first.userId, status: "access_suspended", penaltyId, actor: fixture.actor, requestId: "account-test", at: penaltyAt })).toEqual({ changed: true });
      expect(await port.setAccountAccess(tx, { userId: first.userId, status: "access_suspended", penaltyId, actor: fixture.actor, requestId: "account-test", at: penaltyAt })).toEqual({ changed: false });
    });
    expect((await db.select().from(identityUsers).where(eq(identityUsers.id, first.userId)))[0]).toMatchObject({ accessStatus: "access_suspended", authorizationVersion: 2 });
    const revoked = await db.select().from(identitySessions).where(eq(identitySessions.userId, first.userId));
    expect(revoked).toHaveLength(2); expect(revoked.every((row) => row.revokedAt?.getTime() === penaltyAt.getTime() && row.revocationReason === "account_enforcement")).toBe(true);
    expect((await db.select().from(identityStepUpProofs).where(eq(identityStepUpProofs.id, proofId)))[0]?.consumedAt).toEqual(penaltyAt);
    expect((await db.select().from(identityOidcPendingCommands).where(eq(identityOidcPendingCommands.id, pendingId)))[0]).toMatchObject({ consumedAt: penaltyAt, payloadEnvelope: null });
    expect(await db.transaction((tx) => assurance.getTipSessionAssurance(tx, first, penaltyAt))).toBeNull();
    expect(await resolveSession({ token: first.token, now: penaltyAt })).toBeNull();
    expect(await resolveSession({ token: second.token, now: penaltyAt })).toBeNull();
    const events = await db.select().from(systemOutbox).where(eq(systemOutbox.aggregateId, first.userId));
    expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ eventType: "identity.account_access_changed.v1", payload: { userId: first.userId, status: "access_suspended" } });
  });
  test("setCreatorCapability removed clears the published page head and restored records its penalty", async () => {
    const fixture = await seedPenaltySubject(client); const penaltyId = await insertTestPenalty(client, fixture, { kind: "removal" });
    const pageId = randomUUID(); const publishedId = randomUUID();
    await db.insert(creatorPages).values({ id: pageId, userId: fixture.userId, initializedFromRevisionId: fixture.revisionId, createdAt: penaltyAt, updatedAt: penaltyAt });
    await client`insert into creator_publication_revisions (id, page_id, revision_number, canonical_handle, display_name, short_introduction,
      primary_discipline, secondary_disciplines, actor_user_id, actor_session_id, expected_draft_version, request_id, published_at)
      values (${publishedId}, ${pageId}, 1, ${"artist-" + pageId.slice(0, 8)}, 'Artist', 'Introduction', 'illustration', '{}', ${fixture.userId}, 'session', 1, 'fixture', ${penaltyAt.toISOString()})`;
    await db.update(creatorPages).set({ publishedRevisionId: publishedId }).where(eq(creatorPages.id, pageId));
    await db.transaction(async (tx) => {
      await lock(tx, fixture.userId);
      expect(await port.setCreatorCapability(tx, { userId: fixture.userId, state: "removed", penaltyId, actor: fixture.actor, requestId: "remove-test", at: penaltyAt })).toEqual({ changed: true });
      expect(await port.setCreatorCapability(tx, { userId: fixture.userId, state: "removed", penaltyId, actor: fixture.actor, requestId: "remove-test", at: penaltyAt })).toEqual({ changed: false });
    });
    expect((await db.select().from(creatorPages).where(eq(creatorPages.id, pageId)))[0]?.publishedRevisionId).toBeNull();
    expect((await db.select().from(identityCreatorCapabilities).where(eq(identityCreatorCapabilities.id, fixture.capabilityId)))[0]).toMatchObject({ state: "removed", version: 2, suspendedAt: penaltyAt });
    await db.transaction(async (tx) => {
      await lock(tx, fixture.userId);
      await port.setCreatorCapability(tx, { userId: fixture.userId, state: "active", penaltyId, actor: null, requestId: "restore-test", at: penaltyAt });
    });
    const events = await db.select().from(identityCreatorCapabilityEvents).where(eq(identityCreatorCapabilityEvents.capabilityId, fixture.capabilityId));
    expect(events).toHaveLength(2);
    expect(events.find((row) => row.action === "removed")).toMatchObject({ penaltyId, actorUserId: fixture.ownerUserId });
    expect(events.find((row) => row.action === "restored")).toMatchObject({ penaltyId, actorUserId: null, actorSessionId: null, stepUpProofId: null, reasonCode: "penalty_expired", state: "active" });
    expect((await db.select().from(systemOutbox).where(eq(systemOutbox.aggregateId, fixture.capabilityId))).map((row) => row.eventType).sort())
      .toEqual(["creator.capability_removed.v1", "creator.capability_restored.v1"]);
  });
  test("lockSubject reports isOwner for an active owner grant", async () => {
    const fixture = await seedPenaltySubject(client);
    await db.insert(identityRoleGrants).values({ userId: fixture.userId, role: "owner", grantSource: "bootstrap_cli" });
    expect(await db.transaction((tx) => lock(tx, fixture.userId))).toMatchObject({ userId: fixture.userId, isOwner: true, capability: { id: fixture.capabilityId, state: "active", version: 1 } });
    await db.update(identityRoleGrants).set({ state: "revoked", revokedAt: penaltyAt }).where(eq(identityRoleGrants.userId, fixture.userId));
    expect(await db.transaction((tx) => lock(tx, fixture.userId))).toMatchObject({ isOwner: false });
    expect(await db.transaction((tx) => lock(tx, randomUUID()))).toBeNull();
  });
  test("readCreatorStanding is suspended for removed capability and closed account", async () => {
    const fixture = await seedPenaltySubject(client); const standing = createCreatorStandingPort();
    await db.update(identityCreatorCapabilities).set({ state: "removed", suspendedAt: penaltyAt }).where(eq(identityCreatorCapabilities.id, fixture.capabilityId));
    expect(await db.transaction((tx) => standing.readCreatorStanding(tx, fixture.userId))).toBe("suspended");
    await db.update(identityCreatorCapabilities).set({ state: "active", suspendedAt: null }).where(eq(identityCreatorCapabilities.id, fixture.capabilityId));
    await db.update(identityUsers).set({ accessStatus: "closed" }).where(eq(identityUsers.id, fixture.userId));
    expect(await db.transaction((tx) => standing.readCreatorStanding(tx, fixture.userId))).toBe("suspended");
  });
  test("readCreatorStanding keeps skipLocked when an enforcement writer holds the capability", async () => {
    const fixture = await seedPenaltySubject(client); const held = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const writer = db.transaction(async (tx) => { await tx.select().from(identityCreatorCapabilities).where(eq(identityCreatorCapabilities.id, fixture.capabilityId)).for("update"); held.resolve(); await release.promise; });
    await held.promise;
    try { await expect(db.transaction((tx) => createCreatorStandingPort().readCreatorStanding(tx, fixture.userId))).rejects.toMatchObject({ name: "CommissionEligibilityBusyError" }); }
    finally { release.resolve(); await writer; }
  });
});
