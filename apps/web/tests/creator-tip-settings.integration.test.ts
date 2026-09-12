import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  adminAuditEvents, createDatabase, creatorDiscoveryProjections, creatorHandleClaims, creatorPages,
  creatorPublicationRevisions, creatorTipSettingRevisions, identityUsers,
  paymentsReceivingAccountOnboarding, systemCommandIdempotency, systemOutbox, type PawketDatabase,
} from "@pawket/database";
import { createCreatorTipSettingsService, createPublicCatalogQuery, type CreatorSeed } from "@pawket/catalog";
import { createIdentityCreatorTipAccountPort } from "@pawket/identity";
import { createTipReceivingAccountEligibilityPort, fingerprintReceivingAccount } from "@pawket/payments";
import { createEncryptionKeyring, encryptSensitiveField } from "@pawket/security";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for creator tip integration tests");
const schemaName = `creator_tips_${process.pid}_${Date.now()}`;
const journalSchema = `${schemaName}_journal`;
const admin = createDatabase(databaseUrl);
let db: PawketDatabase;
let close: () => Promise<void>;
const at = new Date("2026-09-12T00:00:00Z");
const key = new Uint8Array(32).fill(74); // Synthetic test-only key material.
const keyring = createEncryptionKeyring({ activeKeyId: "tip-settings-test", keys: { "tip-settings-test": key } });
const seeds = new Map<string, CreatorSeed>();
const heldPages = new Set<string>();
const amountPolicy = { minimumVnd: 10_000, maximumVnd: 5_000_000, allowedPresetsVnd: [20_000, 50_000, 100_000, 200_000] };

function service(overrides: Partial<Parameters<typeof createCreatorTipSettingsService>[0]> = {}) {
  const visibility = createPublicCatalogQuery({
    db, publishingMode: "general_audience",
    creatorSeeds: {
      async getCreatorSeed(_db, userId) { return seeds.get(userId) ?? null; },
      async getCreatorSeeds(_db, userIds) { return new Map(userIds.map((id) => [id, seeds.get(id) ?? null])); },
    },
    visibility: {
      async readHolds(_db, pageId) { return { pageHeld: heldPages.has(pageId), heldShowcaseIds: new Set<string>() }; },
      async readHoldsBatch(_db, requests) { return new Map(requests.map((r) => [r.pageId, { pageHeld: heldPages.has(r.pageId), heldShowcaseIds: new Set<string>() }])); },
    },
    mediaCatalog: {
      async resolveReadyAssets() { return new Map(); },
      async resolveReadyAssetsBatch(_db, requests) { return new Map(requests.map((r) => [r.ownerUserId, new Map()])); },
    },
  });
  return createCreatorTipSettingsService({
    db, visibility, creatorAccount: createIdentityCreatorTipAccountPort(),
    receivingAccount: createTipReceivingAccountEligibilityPort({ keyring, lookupHmacKey: key }),
    paymentsMode: "manual_only", publishingMode: "general_audience", amountPolicy,
    recentAuthMs: 900_000, commandFingerprintKey: key, now: () => at, ...overrides,
  });
}

async function fixture(accountNumber = "0000001234567", bindingId?: string) {
  const userId = `tip-artist-${randomUUID()}`;
  const pageId = randomUUID(); const publicationId = randomUUID(); const accountVersionId = randomUUID();
  const handle = `tips-${randomUUID().slice(0, 8)}`;
  seeds.set(userId, { userId, capabilityState: "active", capabilityVersion: 1, approvedRevisionId: randomUUID(), displayName: "Test artist", introduction: "Test introduction" });
  await db.transaction(async (tx) => {
    await tx.insert(identityUsers).values({ id: userId, name: "Synthetic Artist", email: `${userId}@example.invalid`, canonicalEmail: `${userId}@example.invalid`, emailVerified: true, emailVerifiedAt: at, emailVerificationProvenance: "password_email_challenge", createdAt: at, updatedAt: at });
    await tx.insert(creatorPages).values({ id: pageId, userId, initializedFromRevisionId: seeds.get(userId)!.approvedRevisionId, createdAt: at, updatedAt: at });
    await tx.insert(creatorHandleClaims).values({ id: randomUUID(), pageId, normalizedHandle: handle, kind: "canonical", claimedAt: at });
    await tx.insert(creatorPublicationRevisions).values({ id: publicationId, pageId, revisionNumber: 1, canonicalHandle: handle, displayName: "Test artist", shortIntroduction: "Test introduction", primaryDiscipline: "illustration", secondaryDisciplines: [], actorUserId: userId, actorSessionId: "synthetic-session", expectedDraftVersion: 1, requestId: randomUUID(), publishedAt: at });
    await tx.update(creatorPages).set({ publishedRevisionId: publicationId }).where(eq(creatorPages.id, pageId));
    await tx.insert(creatorDiscoveryProjections).values({ pageId, revisionId: publicationId, canonicalHandle: handle, displayName: "Test artist", shortIntroduction: "Test introduction", disciplines: ["illustration"], revisionAt: at, enabled: true });
    await tx.insert(paymentsReceivingAccountOnboarding).values({
      id: accountVersionId, onboardingId: randomUUID(), applicantUserId: userId, version: 1, bankBin: "970436", bankName: "Vietcombank",
      maskedSuffix: `•••• ${accountNumber.slice(-4)}`, accountFingerprint: fingerprintReceivingAccount({ bankBin: "970436", accountNumber, key }),
      accountNumberEnvelope: encryptSensitiveField({ keyring, plaintext: accountNumber, binding: { recordType: "payments_receiving_account", recordId: bindingId ?? accountVersionId, fieldName: "account_number" } }),
      accountHolderLabelEnvelope: encryptSensitiveField({ keyring, plaintext: "SYNTHETIC ARTIST", binding: { recordType: "payments_receiving_account", recordId: accountVersionId, fieldName: "account_holder_label" } }),
      proofState: "verified", proofVerifiedAt: at, createdAt: at, updatedAt: at,
    });
  });
  return { userId, pageId, handle, publicationId, accountVersionId, accountNumber };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const command = (f: Fixture) => ({ actor: { userId: f.userId, sessionId: "synthetic-session", primaryAuthenticatedAt: at }, pageId: f.pageId, expectedRevision: 0, enabled: true, presetsVnd: [20_000, 50_000, 100_000], idempotencyKey: randomUUID(), requestId: randomUUID() });
const eligible = (f: Fixture, svc = service()) => db.transaction((tx) => svc.getTipEligibility(tx, f.handle));
async function evidence(f: Fixture) {
  return Promise.all([
    db.select().from(creatorTipSettingRevisions).where(eq(creatorTipSettingRevisions.creatorUserId, f.userId)),
    db.select().from(adminAuditEvents).where(eq(adminAuditEvents.subjectId, f.userId)),
    db.select().from(systemOutbox).where(eq(systemOutbox.aggregateId, f.userId)),
    db.select().from(systemCommandIdempotency).where(eq(systemCommandIdempotency.actorUserId, f.userId)),
  ]);
}

beforeAll(async () => {
  await admin.db.execute(sql.raw(`create schema "${schemaName}"`));
  const url = new URL(databaseUrl); url.searchParams.set("options", `-csearch_path=${schemaName},public`);
  const connection = createDatabase(url.toString()); db = connection.db; close = connection.close;
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../../packages/database/migrations/", import.meta.url)), migrationsSchema: journalSchema });
});
afterAll(async () => {
  await close?.();
  await admin.db.execute(sql.raw(`drop schema if exists "${schemaName}" cascade`));
  await admin.db.execute(sql.raw(`drop schema if exists "${journalSchema}" cascade`));
  await admin.close();
});

describe("creator tip settings and module eligibility ports", () => {
  test("requires creator opt-in and atomically saves policy, audit, outbox and replay facts", async () => {
    const f = await fixture(); const svc = service(); const save = command(f);
    expect(await eligible(f, svc)).toBeNull();
    expect(await svc.getSettings({ actorUserId: f.userId, pageId: f.pageId })).toMatchObject({ revisionNumber: 0, enabled: false, available: true });
    const first = await svc.saveSettings(save);
    expect(first).toMatchObject({ revisionNumber: 1, enabled: true, presetsVnd: save.presetsVnd });
    expect(await svc.saveSettings(save)).toEqual(first);
    expect((await evidence(f)).map((rows) => rows.length)).toEqual([1, 1, 1, 1]);
    const result = await eligible(f, svc);
    expect(result).toMatchObject({ pageId: f.pageId, creatorUserId: f.userId, settingRevisionId: first.revisionId, receivingAccountVersionId: f.accountVersionId, minimumVnd: 10_000, maximumVnd: 5_000_000 });
    expect(JSON.stringify([result, await evidence(f)])).not.toContain(f.accountNumber);
    expect(JSON.stringify([result, await evidence(f)])).not.toContain("SYNTHETIC ARTIST");
  });

  test("idempotent replay cannot overwrite a newer setting and conflicting keys roll back", async () => {
    const f = await fixture(); const svc = service(); const original = command(f);
    const first = await svc.saveSettings(original);
    const second = await svc.saveSettings({ ...command(f), expectedRevision: 1, enabled: false, presetsVnd: [50_000, 100_000, 200_000] });
    expect(second.revisionNumber).toBe(2);
    expect(await svc.saveSettings(original)).toEqual(first);
    expect(await svc.getSettings({ actorUserId: f.userId, pageId: f.pageId })).toMatchObject({ revisionNumber: 2, enabled: false });
    await expect(svc.saveSettings({ ...original, enabled: false })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(svc.saveSettings(command(f))).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect((await evidence(f)).map((rows) => rows.length)).toEqual([2, 2, 2, 2]);
    expect(await eligible(f, svc)).toBeNull();
  });

  test("concurrent initial writes serialize and the same command returns one revision", async () => {
    const f = await fixture(); const svc = service();
    const results = await Promise.allSettled([svc.saveSettings(command(f)), svc.saveSettings(command(f))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "VERSION_CONFLICT" } });
    const second = await fixture(); const same = command(second);
    const repeated = await Promise.all([svc.saveSettings(same), svc.saveSettings(same)]);
    expect(repeated[0]).toEqual(repeated[1]);
    expect((await evidence(second)).map((rows) => rows.length)).toEqual([1, 1, 1, 1]);
  });

  test("wrong creator, stale/future authentication and unapproved presets cannot write", async () => {
    const f = await fixture(); const foreign = await fixture(); const svc = service(); const save = command(f);
    await expect(svc.saveSettings({ ...save, actor: command(foreign).actor })).rejects.toMatchObject({ code: "NOT_FOUND" });
    for (const primaryAuthenticatedAt of [new Date(at.getTime() - 900_001), new Date(at.getTime() + 1), new Date(NaN)]) {
      await expect(svc.saveSettings({ ...save, actor: { ...save.actor, primaryAuthenticatedAt } })).rejects.toMatchObject({ code: "RECENT_AUTH_REQUIRED" });
    }
    for (const presetsVnd of [[20_000, 20_000, 100_000], [20_000, 50_000, 70_000], [20_000, 50_000], ["20000", 50_000, 100_000]]) {
      await expect(svc.saveSettings({ ...save, presetsVnd })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect((await evidence(f)).map((rows) => rows.length)).toEqual([0, 0, 0, 0]);
  });

  test("global modes, publication, holds, capability suspension and account access stop eligibility", async () => {
    const f = await fixture(); const svc = service(); await svc.saveSettings(command(f));
    for (const disabled of [service({ paymentsMode: "disabled" }), service({ publishingMode: "disabled" })]) {
      expect(await eligible(f, disabled)).toBeNull();
      await expect(disabled.saveSettings({ ...command(f), expectedRevision: 1 })).rejects.toMatchObject({ code: "PAYMENTS_DISABLED" });
    }
    heldPages.add(f.pageId); expect(await eligible(f, svc)).toBeNull(); heldPages.delete(f.pageId);
    const seed = seeds.get(f.userId)!; seeds.set(f.userId, { ...seed, capabilityState: "suspended" });
    expect(await eligible(f, svc)).toBeNull(); seeds.set(f.userId, seed);
    await db.update(identityUsers).set({ accessStatus: "access_suspended" }).where(eq(identityUsers.id, f.userId));
    expect(await eligible(f, svc)).toBeNull();
    await db.update(identityUsers).set({ accessStatus: "active" }).where(eq(identityUsers.id, f.userId));
    await db.update(creatorPages).set({ publishedRevisionId: null }).where(eq(creatorPages.id, f.pageId));
    expect(await eligible(f, svc)).toBeNull();
    expect((await evidence(f))[0]).toHaveLength(1);
  });

  test("unsupported historical account lengths and ciphertext copied from another record fail closed", async () => {
    for (const f of [await fixture("00000000000000000001"), await fixture("0000001234567", randomUUID())]) {
      const svc = service();
      expect(await svc.getSettings({ actorUserId: f.userId, pageId: f.pageId })).toMatchObject({ available: false });
      await expect(svc.saveSettings(command(f))).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
      expect((await evidence(f)).every((rows) => rows.length === 0)).toBe(true);
    }
  });

  test("retirement and a narrower platform policy never rewrite historical setting revisions", async () => {
    const f = await fixture(); const svc = service(); const original = await svc.saveSettings(command(f));
    const narrowed = service({ amountPolicy: { minimumVnd: 30_000, maximumVnd: 500_000, allowedPresetsVnd: [50_000, 100_000, 200_000] } });
    expect(await eligible(f, narrowed)).toBeNull();
    await db.update(paymentsReceivingAccountOnboarding).set({ retiredAt: at, updatedAt: at }).where(eq(paymentsReceivingAccountOnboarding.id, f.accountVersionId));
    expect(await eligible(f, svc)).toBeNull();
    expect(await svc.getSettings({ actorUserId: f.userId, pageId: f.pageId })).toMatchObject({ ...original, available: false });
  });

  test("wrong or over-broad provider projections fail closed and a write failure leaves no partial evidence", async () => {
    const f = await fixture();
    const overbroad = service({ receivingAccount: { async getCurrentTipReceivingAccount() { return { accountVersionId: f.accountVersionId, accountNumber: f.accountNumber }; } } });
    await expect(overbroad.saveSettings(command(f))).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
    const failing = service({ receivingAccount: { async getCurrentTipReceivingAccount() { throw new Error("Synthetic port failure"); } } });
    await expect(failing.saveSettings(command(f))).rejects.toThrow("Synthetic port failure");
    expect((await evidence(f)).map((rows) => rows.length)).toEqual([0, 0, 0, 0]);
  });
});
