import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  adminAuditEvents, createDatabase, creatorDiscoveryProjections, creatorHandleClaims, creatorPages,
  creatorPublicationRevisions, identityUsers,
  paymentsReceivingAccountOnboarding, systemCommandIdempotency, systemOutbox, tips, paymentIntents, paymentGuestCapabilities, type PawketDatabase,
} from "@pawket/database";
import { createCreatorTipSettingsService, createPublicCatalogQuery, type CreatorSeed } from "@pawket/catalog";
import { createIdentityCreatorTipAccountPort, createIdentityTipBuyerAccountPort } from "@pawket/identity";
import { createTipReceivingAccountEligibilityPort, fingerprintReceivingAccount, createTipPaymentIntentPort } from "@pawket/payments";
import { createEncryptionKeyring, encryptSensitiveField, decryptSensitiveField, createLookupHmac } from "@pawket/security";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for creator tip integration tests");
const schemaName = `tip_creation_${process.pid}_${Date.now()}`;
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


import { createTipService, type CreateTipCommand } from "@pawket/tips";

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function optedIn() {
  const f = await fixture();
  await service().saveSettings({ actor: { userId: f.userId, sessionId: "synthetic-session", primaryAuthenticatedAt: at },
    pageId: f.pageId, expectedRevision: 0, enabled: true, presetsVnd: [20_000, 50_000, 100_000], idempotencyKey: randomUUID(), requestId: randomUUID() });
  return f;
}
const hmac = (context: string, value: string) => createLookupHmac({ key, context, value });
const command = (f: Fixture): CreateTipCommand => ({ principal: { kind: "guest", context: randomBytes(32).toString("base64url") },
  canonicalHandle: f.handle, amountVnd: 50_000, name: " Synthetic Guest ", message: " Thank you 🎨 ",
  abuseKeyHash: hmac("tip-abuse-key", randomUUID()), idempotencyKey: randomUUID(), requestId: randomUUID() });
function paymentPort(overrides: Partial<Parameters<typeof createTipPaymentIntentPort>[0]> = {}) {
  return createTipPaymentIntentPort({ keyring, lookupHmacKey: key, intentTtlMs: 86_400_000, guestReceiptTtlMs: 604_800_000, openIpLimit: 3, openCreatorLimit: 1000, ...overrides });
}
function createService(overrides: Partial<Parameters<typeof createTipService>[0]> = {}) {
  return createTipService({ db, creatorEligibility: service(), payments: paymentPort(), buyerAccounts: createIdentityTipBuyerAccountPort(),
    paymentsMode: "manual_only", publishingMode: "general_audience", keyring, lookupHmacKey: key, idempotencyTtlMs: 604_800_000, now: () => at, ...overrides });
}
async function evidence(f: Fixture) {
  const tipRows = await db.select().from(tips).where(eq(tips.creatorUserId, f.userId));
  const intents = await db.select().from(paymentIntents).where(eq(paymentIntents.creatorUserId, f.userId));
  const capabilities = await db.select().from(paymentGuestCapabilities).innerJoin(paymentIntents, eq(paymentGuestCapabilities.paymentIntentId, paymentIntents.id)).where(eq(paymentIntents.creatorUserId, f.userId));
  const audit = await db.select().from(adminAuditEvents).where(and(eq(adminAuditEvents.action, "tip.created"), sql`${adminAuditEvents.afterState}->>'creatorUserId' = ${f.userId}`));
  const outbox = await db.select().from(systemOutbox).where(and(eq(systemOutbox.eventType, "tip.created.v1"), sql`${systemOutbox.payload}->>'creatorUserId' = ${f.userId}`));
  const commands = await db.select().from(systemCommandIdempotency).where(and(eq(systemCommandIdempotency.commandScope, "tips.create"), inArray(systemCommandIdempotency.resultReference, tipRows.map((r) => `tip-created-v1:${r.id}`))));
  return { tipRows, intents, capabilities, audit, outbox, commands };
}

describe("atomic tip creation across Tips, Payments, Catalog and Identity", () => {
  test("unpublish committing while creation waits is observed before any intent is created", async () => {
    const f = await optedIn();
    let locked!: (pid: number) => void; const ready = new Promise<number>((resolve) => { locked = resolve; });
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const unpublish = db.transaction(async (tx) => {
      await tx.update(creatorPages).set({ publishedRevisionId: null }).where(eq(creatorPages.id, f.pageId));
      const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      locked(backend!.pid); await gate;
    });
    const pid = await ready;
    const creation = createService().createTip(command(f)).then((value) => ({ value }), (error: unknown) => ({ error }));
    try {
      await vi.waitFor(async () => {
        const [row] = await db.execute<{ blocked: boolean }>(sql`select exists(select 1 from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))) as blocked`);
        expect(row?.blocked).toBe(true);
      }, { timeout: 3000, interval: 20 });
    } finally { release(); }
    await unpublish;
    expect(await creation).toMatchObject({ error: { code: "not_available" } });
    expect((await evidence(f)).tipRows).toHaveLength(0);
  });

  test("account replacement waits for the creation fence and only later tips use the new version", async () => {
    const f = await optedIn(); const ports = paymentPort();
    let entered!: (pid: number) => void; const ready = new Promise<number>((resolve) => { entered = resolve; });
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const svc = createService({ payments: { ...ports, async createIntent(tx, c) {
      const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      entered(backend!.pid); await gate; return ports.createIntent(tx, c);
    } } });
    const firstCommand = command(f);
    const creating = svc.createTip(firstCommand);
    const pid = await ready;
    const nextId = randomUUID(); const nextNumber = "0000007654321";
    const replacing = db.transaction(async (tx) => {
      const [old] = await tx.update(paymentsReceivingAccountOnboarding).set({ retiredAt: at, updatedAt: at }).where(eq(paymentsReceivingAccountOnboarding.id, f.accountVersionId)).returning();
      if (!old) throw new Error("Synthetic account missing");
      await tx.insert(paymentsReceivingAccountOnboarding).values({ ...old, id: nextId, version: old.version + 1, retiredAt: null,
        maskedSuffix: "•••• 4321", accountFingerprint: fingerprintReceivingAccount({ bankBin: old.bankBin, accountNumber: nextNumber, key }),
        accountNumberEnvelope: encryptSensitiveField({ keyring, plaintext: nextNumber, binding: { recordType: "payments_receiving_account", recordId: nextId, fieldName: "account_number" } }),
        accountHolderLabelEnvelope: encryptSensitiveField({ keyring, plaintext: "SYNTHETIC ARTIST", binding: { recordType: "payments_receiving_account", recordId: nextId, fieldName: "account_holder_label" } }),
      });
    });
    try {
      await vi.waitFor(async () => {
        const [row] = await db.execute<{ blocked: boolean }>(sql`select exists(select 1 from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))) as blocked`);
        expect(row?.blocked).toBe(true);
      }, { timeout: 3000, interval: 20 });
    } finally { release(); }
    const first = await creating; await replacing;
    expect(first.instruction.destination.accountNumber).toBe(f.accountNumber);
    const nextService = createService();
    await expect(nextService.createTip(firstCommand)).rejects.toMatchObject({ code: "not_available" });
    const second = await nextService.createTip(command(f));
    expect(second.instruction.destination.accountNumber).toBe(nextNumber);
    expect(new Set((await evidence(f)).intents.map((r) => r.accountVersionId))).toEqual(new Set([f.accountVersionId, nextId]));
  });

  test("creates one encrypted purpose-bound guest intent with private evidence and reproducible receipt access", async () => {
    const f = await optedIn(); const svc = createService(); const c = command(f);
    const created = await svc.createTip(c); const replay = await svc.createTip({ ...c, requestId: randomUUID(), abuseKeyHash: hmac("tip-abuse-key", "changed-network") });
    expect(replay).toEqual(created);
    expect(created.instruction).toMatchObject({ creator: { handle: f.handle, displayName: "Test artist" }, amountVnd: 50_000, state: "awaiting_transfer",
      destination: { bankBin: "970436", accountNumber: f.accountNumber, accountName: "SYNTHETIC ARTIST" }, transferClaimedAt: null });
    expect(created.instruction.reference).toMatch(/^PW[A-F0-9]{20}$/u);
    expect(created.guestCapability?.secret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const stored = await evidence(f);
    expect(Object.values(stored).map((rows) => rows.length)).toEqual([1, 1, 1, 1, 1, 1]);
    const tip = stored.tipRows[0]!; const intent = stored.intents[0]!;
    expect(intent).toMatchObject({ tipId: tip.id, accountVersionId: f.accountVersionId, state: "awaiting_transfer" });
    expect(JSON.parse(decryptSensitiveField({ keyring, envelope: tip.guestContentEnvelope, binding: { recordType: "tips", recordId: tip.id, fieldName: "guest_content" } })))
      .toEqual({ name: "Synthetic Guest", message: "Thank you 🎨" });
    expect(() => decryptSensitiveField({ keyring, envelope: tip.guestContentEnvelope, binding: { recordType: "tips", recordId: randomUUID(), fieldName: "guest_content" } })).toThrow();
    expect(() => decryptSensitiveField({ keyring, envelope: intent.destinationEnvelope, binding: { recordType: "payment_intents", recordId: randomUUID(), fieldName: "destination" } })).toThrow();
    const serialized = JSON.stringify(stored);
    for (const secret of [f.accountNumber, "SYNTHETIC ARTIST", "Synthetic Guest", "Thank you", created.guestCapability!.secret, c.idempotencyKey, created.instruction.reference,
      c.principal.kind === "guest" ? c.principal.context : "unused"]) expect(serialized).not.toContain(secret);
    expect(JSON.stringify(created.instruction)).not.toContain(tip.id);
    expect(JSON.stringify(created.instruction)).not.toContain(intent.id);
  });

  test("same-browser two-tab requests serialize to one intent and changed normalized commands conflict", async () => {
    const f = await optedIn(); const svc = createService(); const c = command(f);
    const results = await Promise.all([svc.createTip(c), svc.createTip(c), svc.createTip(c)]);
    expect(results[0]).toEqual(results[1]); expect(results[1]).toEqual(results[2]);
    await expect(svc.createTip({ ...c, amountVnd: 100_000 })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(svc.createTip({ ...c, message: "changed" })).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect((await evidence(f)).tipRows).toHaveLength(1);
  });

  test("a copied idempotency key in another guest context cannot recover the original capability", async () => {
    const f = await optedIn(); const svc = createService(); const c = command(f);
    const first = await svc.createTip(c);
    const other = await svc.createTip({ ...c, principal: command(f).principal });
    expect(other.instruction.reference).not.toEqual(first.instruction.reference);
    expect(other.guestCapability?.secret).not.toEqual(first.guestCapability?.secret);
    expect((await evidence(f)).tipRows).toHaveLength(2);
  });

  test("signed-in creation binds the buyer and issues no guest capability", async () => {
    const f = await optedIn(); const buyer = await fixture(); const svc = createService();
    const c = { ...command(f), principal: { kind: "buyer" as const, userId: buyer.userId } };
    const created = await svc.createTip(c);
    expect(created.guestCapability).toBeNull(); expect(await svc.createTip(c)).toEqual(created);
    const rows = await evidence(f); expect(rows.capabilities).toHaveLength(0); expect(rows.tipRows[0]?.buyerUserId).toBe(buyer.userId);
    await db.update(identityUsers).set({ accessStatus: "access_suspended" }).where(eq(identityUsers.id, buyer.userId));
    await expect(svc.createTip({ ...c, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "not_authorized" });
    expect((await evidence(f)).tipRows).toHaveLength(1);
  });

  test("concurrent different keys cannot overshoot creator capacity", async () => {
    const f = await optedIn(); const svc = createService({ payments: paymentPort({ openCreatorLimit: 1 }) });
    const results = await Promise.allSettled([svc.createTip(command(f)), svc.createTip(command(f))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "rate_limited" } });
    expect((await evidence(f)).tipRows).toHaveLength(1);
  });

  test("the same IP-derived key across different creators has one serialized capacity budget", async () => {
    const first = await optedIn(); const second = await optedIn(); const svc = createService({ payments: paymentPort({ openIpLimit: 1 }) });
    const abuseKeyHash = command(first).abuseKeyHash;
    const results = await Promise.allSettled([svc.createTip({ ...command(first), abuseKeyHash }), svc.createTip({ ...command(second), abuseKeyHash })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "rate_limited" } });
    expect((await evidence(first)).tipRows.length + (await evidence(second)).tipRows.length).toBe(1);
  });

  test("colliding references retry in the transaction and exhausted collisions roll back everything", async () => {
    const f = await optedIn(); const fixed = "PW00000000000000000000";
    const original = await createService({ payments: paymentPort({ referenceFactory: () => fixed }) }).createTip(command(f));
    let attempts = 0;
    const second = await createService({ payments: paymentPort({ referenceFactory: () => ++attempts < 3 ? fixed : "PW00000000000000000001" }) }).createTip(command(f));
    expect(attempts).toBe(3); expect(second.instruction.reference).not.toBe(original.instruction.reference);
    const before = await evidence(f);
    await expect(createService({ payments: paymentPort({ referenceFactory: () => fixed }) }).createTip(command(f))).rejects.toMatchObject({ code: "dependency_unavailable" });
    expect(await evidence(f)).toEqual(before);
  });

  test("current mode, visibility, opt-in and amount gates reject before persisting a tip", async () => {
    const f = await fixture(); const svc = createService();
    await expect(svc.createTip(command(f))).rejects.toMatchObject({ code: "not_available" });
    const enabled = await optedIn();
    for (const disabled of [createService({ paymentsMode: "disabled" }), createService({ publishingMode: "disabled" })]) {
      await expect(disabled.createTip(command(enabled))).rejects.toMatchObject({ code: "payments_disabled" });
    }
    heldPages.add(enabled.pageId); await expect(svc.createTip(command(enabled))).rejects.toMatchObject({ code: "not_available" }); heldPages.delete(enabled.pageId);
    for (const amountVnd of [0, 9999, 5_000_001, 10_000.1, "20000", Number.MAX_SAFE_INTEGER, NaN]) {
      await expect(svc.createTip({ ...command(enabled), amountVnd })).rejects.toMatchObject({ code: "invalid_amount" });
    }
    expect((await evidence(enabled)).tipRows).toHaveLength(0);
  });

  test("a later account retirement stops replays and never rewrites the locked instruction", async () => {
    const f = await optedIn(); const svc = createService(); const c = command(f); await svc.createTip(c);
    const before = await evidence(f);
    await db.update(paymentsReceivingAccountOnboarding).set({ retiredAt: at, updatedAt: at }).where(eq(paymentsReceivingAccountOnboarding.id, f.accountVersionId));
    await expect(svc.createTip(c)).rejects.toMatchObject({ code: "not_available" });
    await expect(svc.createTip(command(f))).rejects.toMatchObject({ code: "not_available" });
    expect(await evidence(f)).toEqual(before);
  });

  test("an account version mismatch or expanded eligibility port fails closed", async () => {
    const f = await optedIn(); const catalog = service();
    for (const changed of [ { receivingAccountVersionId: randomUUID() }, { bankAccount: f.accountNumber } ]) {
      const svc = createService({ creatorEligibility: { async getTipEligibility(tx, handle) { const result = await catalog.getTipEligibility(tx, handle); return result ? { ...result, ...changed } : null; } } });
      await expect(svc.createTip(command(f))).rejects.toMatchObject({ code: "not_available" });
      expect((await evidence(f)).tipRows).toHaveLength(0);
    }
  });

  test("expiry frees capacity without reviving old instructions", async () => {
    const f = await optedIn(); const ports = paymentPort({ openCreatorLimit: 1 }); const c = command(f);
    await createService({ payments: ports }).createTip(c);
    const later = createService({ payments: ports, now: () => new Date(at.getTime() + 86_400_000) });
    await expect(later.createTip(c)).rejects.toMatchObject({ code: "intent_not_pending" });
    await later.createTip(command(f));
    expect((await evidence(f)).tipRows).toHaveLength(2);
  });

  test("failure after tip/intent/capability insertion rolls back audit, outbox and idempotency together", async () => {
    const f = await optedIn();
    const name = `reject_tip_event_${randomUUID().replaceAll("-", "")}`;
    await db.execute(sql.raw(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type = 'tip.created.v1' THEN RAISE EXCEPTION 'synthetic outbox failure'; END IF; RETURN NEW; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER ${name} BEFORE INSERT ON system_outbox FOR EACH ROW EXECUTE FUNCTION ${name}()`));
    const c = command(f);
    try {
      await expect(createService().createTip(c)).rejects.toMatchObject({ code: "dependency_unavailable", message: "dependency_unavailable" });
      expect(Object.values(await evidence(f)).every((rows) => rows.length === 0)).toBe(true);
      const [left] = await db.select({ total: sql<number>`count(*)::integer` }).from(systemCommandIdempotency).where(eq(systemCommandIdempotency.keyHash, hmac("tip-create-command-key", c.idempotencyKey)));
      expect(left?.total).toBe(0);
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER ${name} ON system_outbox`));
      await db.execute(sql.raw(`DROP FUNCTION ${name}()`));
    }
    await createService().createTip(c);
    expect(Object.values(await evidence(f)).map((rows) => rows.length)).toEqual([1, 1, 1, 1, 1, 1]);
  });
});
