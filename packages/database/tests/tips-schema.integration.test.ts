import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createEncryptionKeyring, createLookupHmac, encryptSensitiveField } from "@pawket/security";

import * as schema from "../src/schema.js";
import {
  PLATFORM_TIP_POLICY_BOOTSTRAP_ID, creatorTipSettings, creatorTipSettingRevisions, identityUsers, paymentConfirmations,
  paymentGuestCapabilities, paymentIntents, paymentsReceivingAccountOnboarding,
  paymentTransferClaims, tips,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for tip schema integration tests");
const migrationsFolder = fileURLToPath(new URL("../migrations/", import.meta.url));
const schemaName = `increment_four_${process.pid}_${Date.now()}`;
const journalSchema = `${schemaName}_journal`;
const client = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
const db = drizzle(client, { schema });
type InsertDb = Pick<typeof db, "insert">;
const at = new Date("2026-09-12T00:00:00.000Z");
const confirmedAt = new Date("2026-09-12T00:01:00.000Z");
const expiresAt = new Date("2026-09-13T00:00:00.000Z");
// Synthetic local-only encryption material, never an operational key.
const key = new Uint8Array(32).fill(42);
const keyring = createEncryptionKeyring({ activeKeyId: "schema-test", keys: { "schema-test": key } });
const hash = (value = randomUUID()) => createLookupHmac({ key, value, context: "tip-schema-test" });
const envelope = <R extends string, F extends string>(recordType: R, recordId: string, fieldName: F, plaintext: string) =>
  encryptSensitiveField({ keyring, plaintext, binding: { recordType, recordId, fieldName } });

async function user(database = db) {
  const id = `tip-schema-${randomUUID()}`;
  await database.insert(identityUsers).values({ id, name: "Synthetic artist", email: `${id}@example.invalid`, canonicalEmail: `${id}@example.invalid`, createdAt: at, updatedAt: at });
  return id;
}

async function draft(guest = true) {
  const creatorUserId = await user();
  const buyerUserId = guest ? null : await user();
  const settingRevisionId = randomUUID();
  const accountVersionId = randomUUID();
  const tipId = randomUUID();
  const intentId = randomUUID();
  await db.insert(creatorTipSettingRevisions).values({
    id: settingRevisionId, creatorUserId, revisionNumber: 1, enabled: true,
    platformPolicyRevisionId: PLATFORM_TIP_POLICY_BOOTSTRAP_ID, minimumVnd: 10_000, maximumVnd: 5_000_000, presetsVnd: [20_000, 50_000, 100_000],
    actorSessionId: "synthetic-session", requestId: randomUUID(), createdAt: at,
  });
  await db.insert(creatorTipSettings).values({ creatorUserId, revisionId: settingRevisionId, createdAt: at, updatedAt: at });
  await db.insert(paymentsReceivingAccountOnboarding).values({
    id: accountVersionId, onboardingId: randomUUID(), applicantUserId: creatorUserId, version: 1,
    bankBin: "970436", bankName: "Vietcombank", maskedSuffix: "•••• 0001", accountFingerprint: hash(),
    accountNumberEnvelope: envelope("receiving_account", accountVersionId, "account_number", "000001"),
    accountHolderLabelEnvelope: envelope("receiving_account", accountVersionId, "holder_label", "TEST ARTIST"),
    proofState: "verified", proofVerifiedAt: at, createdAt: at, updatedAt: at,
  });
  return {
    tip: {
      id: tipId, creatorUserId, buyerUserId, settingRevisionId, platformPolicyRevisionId: PLATFORM_TIP_POLICY_BOOTSTRAP_ID, amountVnd: 50_000,
      guestContentEnvelope: envelope("tips", tipId, "guest_content", '{"name":"Synthetic guest","message":"Test only"}'),
      createdAt: at, updatedAt: at,
    },
    intent: {
      id: intentId, tipId, creatorUserId, amountVnd: 50_000, referenceHash: hash(),
      referenceEnvelope: envelope("payment_intents", intentId, "transfer_reference", "PWTEST000001"),
      destinationEnvelope: envelope("payment_intents", intentId, "destination", '{"bankBin":"970436","accountNumber":"000001","accountName":"TEST ARTIST"}'),
      accountVersionId, abuseKeyHash: hash(), expiresAt, requestId: randomUUID(), createdAt: at, updatedAt: at,
    },
    capability: { id: randomUUID(), paymentIntentId: intentId, capabilityHash: hash(), createdAt: at, expiresAt: new Date("2026-09-19T00:00:00.000Z") },
  };
}
type Draft = Awaited<ReturnType<typeof draft>>;

async function insertGraph(tx: InsertDb, f: Draft, options: {
  tip?: Partial<typeof tips.$inferInsert>; intent?: Partial<typeof paymentIntents.$inferInsert>;
  capability?: false | Partial<typeof paymentGuestCapabilities.$inferInsert>;
} = {}) {
  await tx.insert(tips).values({ ...f.tip, ...options.tip });
  await tx.insert(paymentIntents).values({ ...f.intent, ...options.intent });
  if (options.capability !== false && (f.tip.buyerUserId === null || options.capability)) {
    await tx.insert(paymentGuestCapabilities).values({ ...f.capability, ...(options.capability || {}) });
  }
}
async function fixture(guest = true) {
  const f = await draft(guest);
  await db.transaction((tx) => insertGraph(tx, f));
  return f;
}
function confirmation(f: Draft) {
  return {
    id: randomUUID(), paymentIntentId: f.intent.id, creatorUserId: f.tip.creatorUserId,
    accountVersionId: f.intent.accountVersionId, observedAmountVnd: f.tip.amountVnd,
    referenceHash: f.intent.referenceHash, bankTransactionFingerprint: hash(), attestedReceived: true,
    actorSessionId: "synthetic-session", primaryAuthenticatedAt: at,
    idempotencyKeyHash: hash(), requestId: randomUUID(), confirmedAt,
  };
}
async function confirm(f: Draft, patch: Partial<typeof paymentConfirmations.$inferInsert> = {}) {
  return db.transaction(async (tx) => {
    await tx.insert(paymentConfirmations).values({ ...confirmation(f), ...patch });
    await tx.update(paymentIntents).set({ state: "confirmed", closedAt: confirmedAt, updatedAt: confirmedAt }).where(eq(paymentIntents.id, f.intent.id));
    await tx.update(tips).set({ state: "completed", closedAt: confirmedAt, updatedAt: confirmedAt }).where(eq(tips.id, f.tip.id));
  });
}
async function sqlState(promise: PromiseLike<unknown>, code: string) {
  try { await promise; } catch (error) {
    const cause = (error as { cause?: unknown }).cause ?? error;
    expect(cause).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected SQLSTATE ${code}`);
}

beforeAll(async () => {
  await client.unsafe(`create schema "${schemaName}"`);
  await client.unsafe(`set search_path to "${schemaName}", public`);
  await migrate(db, { migrationsFolder, migrationsSchema: journalSchema });
});
afterAll(async () => {
  await client.unsafe("set search_path to public");
  await client.unsafe(`drop schema if exists "${schemaName}" cascade`);
  await client.unsafe(`drop schema if exists "${journalSchema}" cascade`);
  await client.end();
});

describe("Increment 4 additive payment/tip schema", () => {
  test("migrates the real journal, retains the snapshot chain and reruns idempotently", async () => {
    await migrate(db, { migrationsFolder, migrationsSchema: journalSchema });
    const [count] = await client.unsafe<{ count: number }[]>(`select count(*)::int as count from "${journalSchema}".__drizzle_migrations`);
    const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8"));
    expect(count?.count).toBe(journal.entries.length);
    const previous = JSON.parse(await readFile(join(migrationsFolder, "meta/0023_snapshot.json"), "utf8"));
    const current = JSON.parse(await readFile(join(migrationsFolder, "meta/0024_snapshot.json"), "utf8"));
    expect(current.prevId).toBe(previous.id);
    expect(Object.keys(current.tables).length - Object.keys(previous.tables).length).toBe(7);
    const operations = JSON.parse(await readFile(join(migrationsFolder, "meta/0025_snapshot.json"), "utf8"));
    expect(operations.prevId).toBe(current.id);
    expect(Object.keys(operations.tables)).toEqual(Object.keys(current.tables));
    const policy = JSON.parse(await readFile(join(migrationsFolder, "meta/0026_snapshot.json"), "utf8"));
    expect(policy.prevId).toBe(operations.id);
    expect(Object.keys(policy.tables).filter((table) => !Object.hasOwn(operations.tables, table)).sort()).toEqual([
      "public.platform_tip_policy_current", "public.platform_tip_policy_revisions",
    ]);
    for (const table of ["public.tips", "public.creator_tip_setting_revisions"]) {
      expect(policy.tables[table].columns.platform_policy_revision_id).toMatchObject({ type: "uuid", notNull: false });
    }
    const foreignSchemas = await client<{ schema_name: string }[]>`
      select distinct target_ns.nspname as schema_name from pg_constraint c
      join pg_class source on source.oid = c.conrelid join pg_namespace source_ns on source_ns.oid = source.relnamespace
      join pg_class target on target.oid = c.confrelid join pg_namespace target_ns on target_ns.oid = target.relnamespace
      where c.contype = 'f' and source_ns.nspname = ${schemaName}`;
    expect(foreignSchemas).toEqual([{ schema_name: schemaName }]);
  });

  test("creates isolated guest and buyer graphs with encrypted content and independent ownership", async () => {
    const guest = await fixture();
    const buyer = await fixture(false);
    const [row] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, guest.intent.id));
    expect(row).toMatchObject({ state: "awaiting_transfer", currency: "VND", amountVnd: 50_000, closedAt: null });
    const buyerCapabilities = await db.select().from(paymentGuestCapabilities).where(eq(paymentGuestCapabilities.paymentIntentId, buyer.intent.id));
    expect(buyerCapabilities).toHaveLength(0);
    expect(JSON.stringify(row)).not.toContain("TEST ARTIST");
    const indexes = await client<{ indexdef: string }[]>`select indexdef from pg_indexes where schemaname = ${schemaName} and (tablename like 'payment_%' or tablename = 'tips')`;
    expect(indexes.some((i) => i.indexdef.includes("WHERE (state = 'awaiting_transfer'"))).toBe(true);
    expect(indexes.every((i) => !/envelope|account_number|message/u.test(i.indexdef))).toBe(true);
  });

  test("new tip and creator evidence require the current platform policy and retain immutable provenance", async () => {
    const pending = await draft();
    for (const platformPolicyRevisionId of [null, randomUUID()]) {
      await sqlState(db.transaction((tx) => insertGraph(tx, pending, { tip: { platformPolicyRevisionId } })), "23514");
      await sqlState(db.insert(creatorTipSettingRevisions).values({ id: randomUUID(), creatorUserId: pending.tip.creatorUserId,
        revisionNumber: 2, enabled: true, minimumVnd: 10_000, maximumVnd: 5_000_000, presetsVnd: [20_000, 50_000, 100_000],
        platformPolicyRevisionId, actorSessionId: "synthetic", requestId: randomUUID(), createdAt: at }), "23514");
    }
    const existing = await fixture();
    await sqlState(db.update(tips).set({ platformPolicyRevisionId: null }).where(eq(tips.id, existing.tip.id)), "55000");
    await sqlState(db.update(creatorTipSettingRevisions).set({ platformPolicyRevisionId: null }).where(eq(creatorTipSettingRevisions.id, existing.tip.settingRevisionId)), "55000");
    // Legitimate lifecycle transitions retain the provenance under the generic
    // 0024 immutable-facts guard; adding the field needs no duplicate trigger.
    await confirm(existing);
    const [completed] = await db.select().from(tips).where(eq(tips.id, existing.tip.id));
    expect(completed).toMatchObject({ state: "completed", platformPolicyRevisionId: PLATFORM_TIP_POLICY_BOOTSTRAP_ID });
  });

  test("rejects orphan tips and missing, short-lived or wrong-owner capabilities at commit", async () => {
    const f = await draft();
    await sqlState(db.transaction((tx) => tx.insert(tips).values(f.tip)), "23514");
    await sqlState(db.transaction((tx) => insertGraph(tx, f, { capability: false })), "23514");
    await sqlState(db.transaction((tx) => insertGraph(tx, f, { capability: { expiresAt: confirmedAt } })), "23514");
    const buyer = await draft(false);
    await sqlState(db.transaction((tx) => insertGraph(tx, buyer, { capability: {} })), "23514");
    expect(await db.select().from(tips).where(eq(tips.id, f.tip.id))).toHaveLength(0);
  });

  test("rejects noninteger/unsafe amounts and inconsistent owner or amount bindings", async () => {
    const f = await draft();
    for (const amountVnd of [0, -1, 9_007_199_254_740_992]) {
      await sqlState(db.transaction((tx) => insertGraph(tx, f, { tip: { amountVnd } })), "23514");
    }
    await sqlState(db.transaction((tx) => insertGraph(tx, f, { tip: { amountVnd: 10_000.5 } })), "22P02");
    await sqlState(db.transaction((tx) => insertGraph(tx, f, { tip: { amountVnd: 10_000_000_000_000 }, intent: { amountVnd: 10_000_000_000_000 } })), "23514");
    await sqlState(db.transaction((tx) => insertGraph(tx, f, { intent: { amountVnd: 50_001 } })), "23503");
    await sqlState(db.transaction((tx) => insertGraph(tx, f, { intent: { currency: "USD" } })), "23514");
    const other = await draft();
    await sqlState(db.transaction((tx) => insertGraph(tx, f, { tip: { settingRevisionId: other.tip.settingRevisionId } })), "23503");
    await sqlState(db.transaction((tx) => insertGraph(tx, f, { intent: { accountVersionId: other.intent.accountVersionId } })), "23514");
  });

  test("requires unique reference and capability HMACs with structurally encrypted facts", async () => {
    const first = await fixture();
    const second = await draft();
    await sqlState(db.transaction((tx) => insertGraph(tx, second, { intent: { referenceHash: first.intent.referenceHash } })), "23505");
    await sqlState(db.transaction((tx) => insertGraph(tx, second, { capability: { capabilityHash: first.capability.capabilityHash } })), "23505");
    await sqlState(db.transaction((tx) => insertGraph(tx, second, { intent: { referenceHash: "plaintext-reference" } })), "23514");
    const malformed = {} as typeof second.intent.destinationEnvelope;
    await sqlState(db.transaction((tx) => insertGraph(tx, second, { intent: { destinationEnvelope: malformed } })), "23514");
    await sqlState(db.transaction((tx) => insertGraph(tx, second, { tip: { guestContentEnvelope: malformed } })), "23514");
    await sqlState(db.transaction((tx) => insertGraph(tx, second, { intent: { destinationEnvelope: { ...second.intent.destinationEnvelope, name: "plaintext" } as typeof malformed } })), "23514");
  });

  test("settings retain immutable revisions and cannot adopt another creator's settings or go backwards", async () => {
    const first = await fixture();
    const other = await fixture();
    const next = randomUUID();
    await db.insert(creatorTipSettingRevisions).values({
      id: next, creatorUserId: first.tip.creatorUserId, revisionNumber: 2, enabled: false,
      platformPolicyRevisionId: PLATFORM_TIP_POLICY_BOOTSTRAP_ID, minimumVnd: 10_000, maximumVnd: 5_000_000, presetsVnd: [20_000, 50_000, 100_000],
      actorSessionId: "synthetic", requestId: randomUUID(), createdAt: confirmedAt,
    });
    await db.update(creatorTipSettings).set({ revisionId: next, updatedAt: confirmedAt }).where(eq(creatorTipSettings.creatorUserId, first.tip.creatorUserId));
    await sqlState(db.update(creatorTipSettings).set({ revisionId: first.tip.settingRevisionId }).where(eq(creatorTipSettings.creatorUserId, first.tip.creatorUserId)), "23514");
    await sqlState(db.update(creatorTipSettings).set({ revisionId: next }).where(eq(creatorTipSettings.creatorUserId, other.tip.creatorUserId)), "23503");
    await sqlState(db.update(creatorTipSettingRevisions).set({ enabled: false }).where(eq(creatorTipSettingRevisions.id, first.tip.settingRevisionId)), "55000");
    const [row] = await db.select().from(tips).where(eq(tips.id, first.tip.id));
    expect(row?.settingRevisionId).toBe(first.tip.settingRevisionId);
  });

  test.each([[20_000, 20_000, 100_000], [0, 50_000, 100_000], [20_000, 50_000], []].map((presetsVnd) => ({ presetsVnd })))("rejects invalid three-preset policy $presetsVnd", async ({ presetsVnd }) => {
    const creatorUserId = await user();
    await sqlState(db.insert(creatorTipSettingRevisions).values({
      id: randomUUID(), creatorUserId, revisionNumber: 1, enabled: true,
      platformPolicyRevisionId: PLATFORM_TIP_POLICY_BOOTSTRAP_ID, minimumVnd: 10_000, maximumVnd: 5_000_000, presetsVnd,
      actorSessionId: "synthetic", requestId: randomUUID(), createdAt: at,
    }), "23514");
  });

  test("claims are immutable, non-authoritative, owner-bound and cannot complete payment", async () => {
    const guest = await fixture();
    const other = await fixture();
    const claim = { id: randomUUID(), paymentIntentId: guest.intent.id, accessKind: "guest", guestCapabilityId: guest.capability.id, requestId: randomUUID(), claimedAt: confirmedAt };
    await sqlState(db.insert(paymentTransferClaims).values({ ...claim, guestCapabilityId: other.capability.id }), "23514");
    await sqlState(db.insert(paymentTransferClaims).values({ ...claim, authoritative: true }), "23514");
    await db.insert(paymentTransferClaims).values(claim);
    const [intent] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, guest.intent.id));
    expect(intent?.state).toBe("awaiting_transfer");
    await sqlState(db.update(paymentTransferClaims).set({ claimedAt: expiresAt }).where(eq(paymentTransferClaims.id, claim.id)), "55000");
    await sqlState(db.delete(paymentTransferClaims).where(eq(paymentTransferClaims.id, claim.id)), "55000");
    await sqlState(db.insert(paymentTransferClaims).values({ ...claim, id: randomUUID() }), "23505");
    const buyer = await fixture(false);
    await sqlState(db.insert(paymentTransferClaims).values({ id: randomUUID(), paymentIntentId: buyer.intent.id, accessKind: "buyer", buyerUserId: guest.tip.creatorUserId, requestId: randomUUID(), claimedAt: confirmedAt }), "23514");
    await db.insert(paymentTransferClaims).values({ id: randomUUID(), paymentIntentId: buyer.intent.id, accessKind: "buyer", buyerUserId: buyer.tip.buyerUserId, requestId: randomUUID(), claimedAt: confirmedAt });
  });

  test("confirmation evidence and both aggregate states must commit atomically", async () => {
    const f = await fixture();
    await sqlState(db.transaction((tx) => tx.insert(paymentConfirmations).values(confirmation(f))), "23514");
    await sqlState(db.transaction(async (tx) => {
      await tx.update(paymentIntents).set({ state: "confirmed", closedAt: confirmedAt, updatedAt: confirmedAt }).where(eq(paymentIntents.id, f.intent.id));
      await tx.update(tips).set({ state: "completed", closedAt: confirmedAt, updatedAt: confirmedAt }).where(eq(tips.id, f.tip.id));
    }), "23514");
    await confirm(f);
    const [tip] = await db.select().from(tips).where(eq(tips.id, f.tip.id));
    expect(tip).toMatchObject({ state: "completed", closedAt: confirmedAt });
    await sqlState(db.update(paymentIntents).set({ state: "awaiting_transfer", closedAt: null, updatedAt: at }).where(eq(paymentIntents.id, f.intent.id)), "55000");
    await sqlState(db.update(paymentConfirmations).set({ requestId: "rewrite" }).where(eq(paymentConfirmations.paymentIntentId, f.intent.id)), "55000");
    await sqlState(db.delete(paymentConfirmations).where(eq(paymentConfirmations.paymentIntentId, f.intent.id)), "55000");
  });

  test("rejects terminal initial state, divergent terminal times and stale or future assurance facts", async () => {
    const draftRows = await draft();
    await sqlState(db.transaction((tx) => insertGraph(tx, draftRows, { intent: { state: "confirmed", closedAt: confirmedAt, updatedAt: confirmedAt } })), "23514");
    const f = await fixture();
    for (const patch of [
      { primaryAuthenticatedAt: new Date("2026-09-11T23:00:00.000Z") },
      { primaryAuthenticatedAt: expiresAt }, { totpVerifiedAt: new Date("2026-09-11T23:00:00.000Z") },
      { totpVerifiedAt: expiresAt }, { confirmedAt: expiresAt },
    ]) await sqlState(confirm(f, patch), "23514");
    await sqlState(db.transaction(async (tx) => {
      await tx.insert(paymentConfirmations).values(confirmation(f));
      await tx.update(paymentIntents).set({ state: "confirmed", closedAt: confirmedAt, updatedAt: confirmedAt }).where(eq(paymentIntents.id, f.intent.id));
      await tx.update(tips).set({ state: "completed", closedAt: new Date(confirmedAt.getTime() + 1), updatedAt: new Date(confirmedAt.getTime() + 1) }).where(eq(tips.id, f.tip.id));
    }), "23514");
  });

  test("exact evidence and a globally unique bank fingerprint prevent double confirmation", async () => {
    const f = await fixture();
    const second = await fixture();
    for (const patch of [{ observedAmountVnd: 49_999 }, { referenceHash: hash() }, { accountVersionId: second.intent.accountVersionId }]) {
      await sqlState(confirm(f, patch), "23503");
    }
    await sqlState(confirm(f, { attestedReceived: false }), "23514");
    const fingerprint = hash();
    await confirm(f, { bankTransactionFingerprint: fingerprint });
    await sqlState(confirm(second, { bankTransactionFingerprint: fingerprint }), "23505");
    await sqlState(confirm(f), "23505");
    const [pending] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, second.intent.id));
    expect(pending?.state).toBe("awaiting_transfer");
  });

  test("expiry requires the deadline and cannot confirm later or rewrite locked facts", async () => {
    const f = await fixture();
    await sqlState(db.update(paymentIntents).set({ accountVersionId: randomUUID() }).where(eq(paymentIntents.id, f.intent.id)), "55000");
    await sqlState(db.update(paymentIntents).set({ destinationEnvelope: envelope("payment_intents", f.intent.id, "destination", "replacement") }).where(eq(paymentIntents.id, f.intent.id)), "55000");
    await sqlState(db.transaction(async (tx) => {
      await tx.update(paymentIntents).set({ state: "expired", closedAt: confirmedAt, updatedAt: confirmedAt }).where(eq(paymentIntents.id, f.intent.id));
      await tx.update(tips).set({ state: "expired", closedAt: confirmedAt, updatedAt: confirmedAt }).where(eq(tips.id, f.tip.id));
    }), "23514");
    await db.transaction(async (tx) => {
      await tx.update(tips).set({ state: "expired", closedAt: expiresAt, updatedAt: expiresAt }).where(eq(tips.id, f.tip.id));
      await tx.update(paymentIntents).set({ state: "expired", closedAt: expiresAt, updatedAt: expiresAt }).where(eq(paymentIntents.id, f.intent.id));
    });
    await sqlState(confirm(f), "23514");
    await sqlState(db.insert(paymentTransferClaims).values({ id: randomUUID(), paymentIntentId: f.intent.id, accessKind: "guest", guestCapabilityId: f.capability.id, requestId: randomUUID(), claimedAt: expiresAt }), "23514");
    await sqlState(db.delete(tips).where(eq(tips.id, f.tip.id)), "55000");
    await sqlState(db.delete(paymentGuestCapabilities).where(eq(paymentGuestCapabilities.id, f.capability.id)), "55000");
  });

  test("retired receiving accounts preserve historical intents and cannot authorize new ones or confirmation", async () => {
    const f = await fixture();
    await db.update(paymentsReceivingAccountOnboarding).set({ retiredAt: confirmedAt, updatedAt: confirmedAt }).where(eq(paymentsReceivingAccountOnboarding.id, f.intent.accountVersionId));
    await sqlState(confirm(f), "23514");
    const [historical] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, f.intent.id));
    expect(historical?.destinationEnvelope).toEqual(f.intent.destinationEnvelope);
    const next = await draft();
    await sqlState(db.transaction((tx) => insertGraph(tx, next, { intent: { accountVersionId: f.intent.accountVersionId } })), "23514");
  });

  test("upgrades Increment 3 with prior-code queries/inserts intact and no old table changes", async () => {
    const upgradeSchema = `${schemaName}_upgrade`;
    const upgradeJournal = `${upgradeSchema}_journal`;
    const temporary = await mkdtemp(join(tmpdir(), "pawket-increment-four-upgrade-"));
    const upgrade = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      await mkdir(join(temporary, "meta"));
      const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8"));
      const entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 23);
      await writeFile(join(temporary, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
      for (const entry of entries) await copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(temporary, `${entry.tag}.sql`));
      await upgrade.unsafe(`create schema "${upgradeSchema}"`);
      await upgrade.unsafe(`set search_path to "${upgradeSchema}", public`);
      const upgradeDb = drizzle(upgrade, { schema });
      await migrate(upgradeDb, { migrationsFolder: temporary, migrationsSchema: upgradeJournal });
      const beforeId = await user(upgradeDb);
      const beforeColumns = await upgrade<{ table_name: string; column_name: string; data_type: string }[]>`select table_name,column_name,data_type from information_schema.columns where table_schema = ${upgradeSchema} order by table_name,ordinal_position`;
      await migrate(upgradeDb, { migrationsFolder, migrationsSchema: upgradeJournal });
      const newTables = ["platform_tip_policy_current", "platform_tip_policy_revisions", "creator_tip_settings", "creator_tip_setting_revisions", "tips", "payment_intents", "payment_guest_capabilities", "payment_transfer_claims", "payment_confirmations",
        "payments_sepay_connections", "payments_sepay_connection_revisions", "payments_sepay_oauth_attempts",
        "payments_sepay_account_cutovers", "payments_sepay_inbox", "payments_sepay_inbox_conflicts",
        "payments_sepay_processing", "payments_sepay_transactions", "payments_sepay_decisions", "payments_sepay_provider_budgets"];
      const afterColumns = await upgrade<{ table_name: string; column_name: string; data_type: string }[]>`select table_name,column_name,data_type from information_schema.columns where table_schema = ${upgradeSchema} order by table_name,ordinal_position`;
      expect(afterColumns.filter((row) => !newTables.includes(row.table_name))).toEqual(beforeColumns);
      const afterId = await user(upgradeDb);
      const users = await upgradeDb.select({ id: identityUsers.id }).from(identityUsers);
      expect(users.map((row) => row.id).sort()).toEqual([beforeId, afterId].sort());
      // No down migration: prior application code coexists with added tables.
      await migrate(upgradeDb, { migrationsFolder, migrationsSchema: upgradeJournal });
    } finally {
      await upgrade.unsafe("set search_path to public");
      await upgrade.unsafe(`drop schema if exists "${upgradeSchema}" cascade`);
      await upgrade.unsafe(`drop schema if exists "${upgradeJournal}" cascade`);
      await upgrade.end();
      if (resolve(temporary) !== join(resolve(tmpdir()), basename(temporary)) || !basename(temporary).startsWith("pawket-increment-four-upgrade-")) throw new Error("Unsafe temporary migration cleanup path");
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("0025 to 0026 preserves legacy payment evidence without fabricating provenance and blocks old writers", async () => {
    const original = await fixture();
    const bindings = [
      ["identity_users", "id", original.tip.creatorUserId],
      ["payments_receiving_account_onboarding", "id", original.intent.accountVersionId],
      ["creator_tip_setting_revisions", "id", original.tip.settingRevisionId],
      ["creator_tip_settings", "creator_user_id", original.tip.creatorUserId],
      ["tips", "id", original.tip.id],
      ["payment_intents", "id", original.intent.id],
      ["payment_guest_capabilities", "id", original.capability.id],
    ] as const;
    const rows = await Promise.all(bindings.map(async ([table, field, value]) => {
      const [result] = await client.unsafe<{ row: Record<string, unknown> }[]>(
        `select to_jsonb(item) - 'platform_policy_revision_id' as row from "${table}" item where "${field}" = $1`, [value]);
      return { table, row: result!.row };
    }));
    const upgradeSchema = `${schemaName}_policy_upgrade`;
    const upgradeJournal = `${upgradeSchema}_journal`;
    const temporary = await mkdtemp(join(tmpdir(), "pawket-policy-upgrade-"));
    const upgrade = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      await mkdir(join(temporary, "meta"));
      const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8"));
      const entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 25);
      await writeFile(join(temporary, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
      for (const entry of entries) await copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(temporary, `${entry.tag}.sql`));
      await upgrade.unsafe(`create schema "${upgradeSchema}"`);
      await upgrade.unsafe(`set search_path to "${upgradeSchema}", public`);
      const upgradeDb = drizzle(upgrade, { schema });
      await migrate(upgradeDb, { migrationsFolder: temporary, migrationsSchema: upgradeJournal });
      // Reproduce valid Increment 4 rows with the actual old table types. The
      // fixed table list keeps identifier construction independent of input.
      await upgrade.begin(async (tx) => {
        for (const { table, row } of rows) await tx.unsafe(
          `insert into "${table}" select * from jsonb_populate_record(null::"${table}", $1::jsonb)`, [JSON.stringify(row)]);
      });
      await migrate(upgradeDb, { migrationsFolder, migrationsSchema: upgradeJournal });
      for (const { table, row } of rows) {
        const [actual] = await upgrade.unsafe<{ row: Record<string, unknown> }[]>(`select to_jsonb(item) as row from "${table}" item`);
        expect(actual!.row).toEqual(["tips", "creator_tip_setting_revisions"].includes(table)
          ? { ...row, platform_policy_revision_id: null } : row);
      }
      const [bootstrap] = await upgrade`select origin, actor_user_id from platform_tip_policy_revisions`;
      expect(bootstrap).toEqual({ origin: "system_bootstrap", actor_user_id: null });
      await sqlState(upgradeDb.update(tips).set({ platformPolicyRevisionId: PLATFORM_TIP_POLICY_BOOTSTRAP_ID }).where(eq(tips.id, original.tip.id)), "55000");
      const legacySettings = rows.find((row) => row.table === "creator_tip_setting_revisions")!.row;
      await sqlState(upgrade.unsafe("insert into creator_tip_setting_revisions select * from jsonb_populate_record(null::creator_tip_setting_revisions, $1::jsonb)",
        [JSON.stringify({ ...legacySettings, id: randomUUID(), revision_number: 2 })]), "23514");
      const legacyTip = rows.find((row) => row.table === "tips")!.row;
      await sqlState(upgrade.unsafe("insert into tips select * from jsonb_populate_record(null::tips, $1::jsonb)",
        [JSON.stringify({ ...legacyTip, id: randomUUID() })]), "23514");

      // Narrowing later policy does not govern settlement of the original
      // legacy graph. Confirmation still binds its original amount/account.
      const revisionId = randomUUID();
      await upgrade.begin(async (tx) => {
        await tx`insert into platform_tip_policy_revisions
          (id, revision_number, previous_revision_id, minimum_vnd, maximum_vnd, allowed_presets_vnd,
            origin, actor_user_id, actor_session_id, request_id, reason, effective_at)
          select ${revisionId}, 2, id, 100000, 5000000, array[100000,200000,300000],
            'owner', ${original.tip.creatorUserId}, 'synthetic-session', 'synthetic-request', 'Narrow policy after upgrade', effective_at
          from platform_tip_policy_revisions where revision_number = 1`;
        await tx`update platform_tip_policy_current set revision_id = ${revisionId}`;
      });
      await sqlState(upgradeDb.insert(creatorTipSettingRevisions).values({
        id: randomUUID(), creatorUserId: original.tip.creatorUserId, revisionNumber: 2, enabled: true,
        platformPolicyRevisionId: PLATFORM_TIP_POLICY_BOOTSTRAP_ID, minimumVnd: 100_000, maximumVnd: 5_000_000,
        presetsVnd: [100_000, 200_000, 300_000], actorSessionId: "synthetic-session", requestId: randomUUID(), createdAt: at,
      }), "23514");
      await upgradeDb.transaction(async (tx) => {
        await tx.insert(paymentConfirmations).values(confirmation(original));
        await tx.update(paymentIntents).set({ state: "confirmed", closedAt: confirmedAt, updatedAt: confirmedAt }).where(eq(paymentIntents.id, original.intent.id));
        await tx.update(tips).set({ state: "completed", closedAt: confirmedAt, updatedAt: confirmedAt }).where(eq(tips.id, original.tip.id));
      });
      const [completed] = await upgradeDb.select().from(tips).where(eq(tips.id, original.tip.id));
      expect(completed).toMatchObject({ state: "completed", amountVnd: 50_000, platformPolicyRevisionId: null });
      await migrate(upgradeDb, { migrationsFolder, migrationsSchema: upgradeJournal });
      const [count] = await upgrade`select count(*)::int as count from platform_tip_policy_revisions`;
      expect(count!.count).toBe(2);
    } finally {
      await upgrade.unsafe("set search_path to public");
      await upgrade.unsafe(`drop schema if exists "${upgradeSchema}" cascade`);
      await upgrade.unsafe(`drop schema if exists "${upgradeJournal}" cascade`);
      await upgrade.end();
      if (resolve(temporary) !== join(resolve(tmpdir()), basename(temporary)) || !basename(temporary).startsWith("pawket-policy-upgrade-")) throw new Error("Unsafe temporary migration cleanup path");
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
