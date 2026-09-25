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

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for SePay schema integration tests");
const migrationsFolder = fileURLToPath(new URL("../migrations/", import.meta.url));
const schemaName = `sepay_schema_${process.pid}_${Date.now()}`;
const journalSchema = `${schemaName}_journal`;
const client = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
const db = drizzle(client, { schema });
const at = new Date("2026-09-24T00:00:00.000Z");
const cutoverAt = new Date("2026-09-24T00:01:00.000Z");
const createdAt = new Date("2026-09-24T00:02:00.000Z");
const transferAt = new Date("2026-09-24T00:03:00.000Z");
const verifiedAt = new Date("2026-09-24T00:04:00.000Z");
const expiresAt = new Date("2026-09-25T00:00:00.000Z");
const key = new Uint8Array(32).fill(52);
const keyring = createEncryptionKeyring({ activeKeyId: "sepay-test", keys: { "sepay-test": key } });
const hash = (value = randomUUID()) => createLookupHmac({ key, value, context: "sepay-schema-test" });
const digest = `sha256:${"a".repeat(64)}`;
const envelope = <R extends string, F extends string>(recordType: R, recordId: string, fieldName: F, plaintext = "synthetic only") =>
  encryptSensitiveField({ keyring, plaintext, binding: { recordType, recordId, fieldName } });
type InsertDb = Pick<typeof db, "insert">;

async function expectSql(promise: PromiseLike<unknown>, code = "23514") {
  try { await promise; } catch (error) {
    expect((error as { cause?: unknown }).cause ?? error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected SQLSTATE ${code}`);
}

async function creator(accountFingerprint = hash()) {
  const id = `sepay-schema-${randomUUID()}`;
  await db.insert(schema.identityUsers).values({ id, name: "Synthetic creator", email: `${id}@example.invalid`, canonicalEmail: `${id}@example.invalid`, createdAt: at, updatedAt: at });
  const accountVersionId = randomUUID();
  await db.insert(schema.paymentsReceivingAccountOnboarding).values({
    id: accountVersionId, onboardingId: randomUUID(), applicantUserId: id, version: 1,
    bankBin: "970436", bankName: "Vietcombank", maskedSuffix: "•••• 0001", accountFingerprint,
    accountNumberEnvelope: envelope("receiving_account", accountVersionId, "account_number"),
    accountHolderLabelEnvelope: envelope("receiving_account", accountVersionId, "holder_label"),
    proofState: "verified", proofVerifiedAt: at, createdAt: at, updatedAt: at,
  });
  const settingRevisionId = randomUUID();
  await db.insert(schema.creatorTipSettingRevisions).values({
    id: settingRevisionId, creatorUserId: id, revisionNumber: 1, enabled: true,
    platformPolicyRevisionId: schema.PLATFORM_TIP_POLICY_BOOTSTRAP_ID,
    minimumVnd: 10_000, maximumVnd: 5_000_000, presetsVnd: [20_000, 50_000, 100_000],
    actorSessionId: "synthetic-session", requestId: randomUUID(), createdAt: at,
  });
  await db.insert(schema.creatorTipSettings).values({ creatorUserId: id, revisionId: settingRevisionId, createdAt: at, updatedAt: at });
  return { creatorUserId: id, accountVersionId, accountFingerprint, settingRevisionId };
}
type Creator = Awaited<ReturnType<typeof creator>>;

async function readyConnection(owner: Creator) {
  const id = randomUUID();
  const revisionId = randomUUID();
  await db.insert(schema.paymentsSepayConnections).values({
    id, creatorUserId: owner.creatorUserId, accountVersionId: owner.accountVersionId,
    accountFingerprint: owner.accountFingerprint, providerEnvironment: "test", createdAt: at, updatedAt: at,
  });
  await db.insert(schema.paymentsSepayConnectionRevisions).values({
    id: revisionId, connectionId: id, revisionNumber: 1, providerTenantId: `synthetic-${id}`, providerAccountId: "11",
    accessTokenEnvelope: envelope("sepay_revision", revisionId, "access_token"),
    refreshTokenEnvelope: envelope("sepay_revision", revisionId, "refresh_token"),
    webhookSecretEnvelope: envelope("sepay_revision", revisionId, "webhook_secret"),
    providerBindingEnvelope: envelope("sepay_revision", revisionId, "provider_binding"),
    accessTokenExpiresAt: expiresAt, scopes: ["bank-account:read", "transaction:read"],
    capabilityEvidence: { stableIdentity: true, eventMapping: true }, createdAt: at,
  });
  await db.update(schema.paymentsSepayConnections).set({ status: "ready", version: 2, currentRevisionId: revisionId,
    automationEnabled: true, providerTenantId: `synthetic-${id}`, providerAccountId: "11", updatedAt: at }).where(eq(schema.paymentsSepayConnections.id, id));
  return { id, revisionId, providerTenantId: `synthetic-${id}`, providerAccountId: "11" };
}
type Connection = Awaited<ReturnType<typeof readyConnection>>;
function cutover(owner: Creator, connection: Connection) {
  return { id: randomUUID(), accountFingerprint: owner.accountFingerprint, creatorUserId: owner.creatorUserId,
    connectionId: connection.id, providerEnvironment: "test", providerTenantId: connection.providerTenantId,
    providerAccountId: connection.providerAccountId, actorSessionId: "synthetic-session",
    primaryAuthenticatedAt: at, cutoverAt };
}
function graph(owner: Creator, cutoverId: string | null = null) {
  const tipId = randomUUID();
  const intentId = randomUUID();
  return {
    tip: { id: tipId, creatorUserId: owner.creatorUserId, buyerUserId: owner.creatorUserId, settingRevisionId: owner.settingRevisionId,
      platformPolicyRevisionId: schema.PLATFORM_TIP_POLICY_BOOTSTRAP_ID, amountVnd: 50_000,
      guestContentEnvelope: envelope("tips", tipId, "guest_content"), createdAt, updatedAt: createdAt },
    intent: { id: intentId, tipId, creatorUserId: owner.creatorUserId, amountVnd: 50_000, accountVersionId: owner.accountVersionId,
      settlementLane: cutoverId ? "provider_bound" : "manual_attested", cutoverId, referenceHash: hash(), abuseKeyHash: hash(),
      referenceEnvelope: envelope("payment_intents", intentId, "transfer_reference"),
      destinationEnvelope: envelope("payment_intents", intentId, "destination"), expiresAt, requestId: randomUUID(), createdAt, updatedAt: createdAt },
  };
}
type Graph = ReturnType<typeof graph>;
async function insertGraph(tx: InsertDb, g: Graph) {
  await tx.insert(schema.tips).values(g.tip);
  await tx.insert(schema.paymentIntents).values(g.intent);
}
function manualConfirmation(g: Graph) {
  return { id: randomUUID(), paymentIntentId: g.intent.id, creatorUserId: g.intent.creatorUserId,
    accountVersionId: g.intent.accountVersionId, observedAmountVnd: g.intent.amountVnd, referenceHash: g.intent.referenceHash,
    bankTransactionFingerprint: hash(), source: "creator_manual", attestedReceived: true, actorSessionId: "synthetic-session",
    primaryAuthenticatedAt: at, idempotencyKeyHash: hash(), requestId: randomUUID(), confirmedAt: verifiedAt };
}
async function confirmManual(g: Graph) {
  await db.transaction(async (tx) => {
    await tx.insert(schema.paymentConfirmations).values(manualConfirmation(g));
    await tx.update(schema.paymentIntents).set({ state: "confirmed", closedAt: verifiedAt, updatedAt: verifiedAt }).where(eq(schema.paymentIntents.id, g.intent.id));
    await tx.update(schema.tips).set({ state: "completed", closedAt: verifiedAt, updatedAt: verifiedAt }).where(eq(schema.tips.id, g.tip.id));
  });
}
async function providerFixture() {
  const owner = await creator();
  const connection = await readyConnection(owner);
  const boundary = cutover(owner, connection);
  await db.insert(schema.paymentsSepayAccountCutovers).values(boundary);
  const g = graph(owner, boundary.id);
  await db.transaction((tx) => insertGraph(tx, g));
  const inboxId = randomUUID();
  await db.insert(schema.paymentsSepayInbox).values({ id: inboxId, connectionId: connection.id, connectionRevisionId: connection.revisionId,
    providerEventId: "111", payloadDigest: digest, rawEnvelope: envelope("sepay_inbox", inboxId, "raw"),
    disposition: "accepted", normalizedFacts: { amountVnd: 50_000 }, receivedAt: transferAt });
  const transaction = { id: randomUUID(), providerEnvironment: "test", providerTenantId: connection.providerTenantId,
    providerAccountId: connection.providerAccountId, providerTransactionId: "111", connectionId: connection.id,
    connectionRevisionId: connection.revisionId, connectionVersion: 2, inboxId, paymentIntentId: g.intent.id,
    amountVnd: 50_000, referenceHash: g.intent.referenceHash, accountFingerprint: owner.accountFingerprint,
    transferAt, verifiedAt, readbackDigest: digest };
  const confirmation = { id: randomUUID(), paymentIntentId: g.intent.id, creatorUserId: owner.creatorUserId,
    accountVersionId: owner.accountVersionId, observedAmountVnd: 50_000, referenceHash: g.intent.referenceHash,
    providerTransactionId: transaction.id, source: "sepay_automatic", workerIdentity: "synthetic-worker",
    requestId: randomUUID(), confirmedAt: verifiedAt };
  return { owner, connection, boundary, g, inboxId, transaction, confirmation };
}
type ProviderFixture = Awaited<ReturnType<typeof providerFixture>>;
async function confirmProvider(f: ProviderFixture, patch: Partial<typeof schema.paymentConfirmations.$inferInsert> = {}, transactionPatch: Partial<typeof schema.paymentsSepayTransactions.$inferInsert> = {}) {
  await db.transaction(async (tx) => {
    await tx.insert(schema.paymentsSepayTransactions).values({ ...f.transaction, ...transactionPatch });
    await tx.insert(schema.paymentConfirmations).values({ ...f.confirmation, ...patch });
    await tx.update(schema.paymentIntents).set({ state: "confirmed", closedAt: verifiedAt, updatedAt: verifiedAt }).where(eq(schema.paymentIntents.id, f.g.intent.id));
    await tx.update(schema.tips).set({ state: "completed", closedAt: verifiedAt, updatedAt: verifiedAt }).where(eq(schema.tips.id, f.g.tip.id));
  });
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

describe("SePay persistence and legacy-writer database fences", () => {
  test("generates a chained additive snapshot and binds every foreign key to the selected schema", async () => {
    const previous = JSON.parse(await readFile(join(migrationsFolder, "meta/0026_snapshot.json"), "utf8"));
    const current = JSON.parse(await readFile(join(migrationsFolder, "meta/0027_snapshot.json"), "utf8"));
    expect(current.prevId).toBe(previous.id);
    expect(Object.keys(current.tables).length - Object.keys(previous.tables).length).toBe(9);
    const schemas = await client<{ target: string }[]>`select distinct target_ns.nspname as target from pg_constraint c
      join pg_class source on source.oid = c.conrelid join pg_namespace source_ns on source_ns.oid = source.relnamespace
      join pg_class target on target.oid = c.confrelid join pg_namespace target_ns on target_ns.oid = target.relnamespace
      where c.contype = 'f' and source_ns.nspname = ${schemaName}`;
    expect(schemas).toEqual([{ target: schemaName }]);
    await migrate(db, { migrationsFolder, migrationsSchema: journalSchema });
  });

  test("preserves manual confirmation and rejects a null or mixed evidence discriminator", async () => {
    const owner = await creator(); const g = graph(owner);
    await db.transaction((tx) => insertGraph(tx, g));
    for (const patch of [{ actorSessionId: null }, { bankTransactionFingerprint: null }, { attestedReceived: null }, { workerIdentity: "fabricated-worker" }]) {
      await expectSql(db.insert(schema.paymentConfirmations).values({ ...manualConfirmation(g), ...patch }));
    }
    await confirmManual(g);
    expect((await db.select().from(schema.paymentConfirmations).where(eq(schema.paymentConfirmations.paymentIntentId, g.intent.id)))[0]).toMatchObject({ source: "creator_manual", providerTransactionId: null, workerIdentity: null });
  });

  test("refuses cutover with open manual intents and with ambiguous current ownership", async () => {
    const owner = await creator(); const connection = await readyConnection(owner); const g = graph(owner);
    await db.transaction((tx) => insertGraph(tx, g));
    await expectSql(db.insert(schema.paymentsSepayAccountCutovers).values(cutover(owner, connection)));
    await confirmManual(g);
    const other = await creator(owner.accountFingerprint);
    await expectSql(db.insert(schema.paymentsSepayAccountCutovers).values(cutover(owner, connection)));
    await db.update(schema.paymentsReceivingAccountOnboarding).set({ retiredAt: verifiedAt, updatedAt: verifiedAt }).where(eq(schema.paymentsReceivingAccountOnboarding.id, other.accountVersionId));
    await db.insert(schema.paymentsSepayAccountCutovers).values(cutover(owner, connection));
  });

  test("drains all historical account lineages and rejects old writers after cutover even on another creator", async () => {
    const owner = await creator(); const previous = await creator(owner.accountFingerprint); const connection = await readyConnection(owner);
    const g = graph(previous);
    await db.transaction((tx) => insertGraph(tx, g));
    await db.update(schema.paymentsReceivingAccountOnboarding).set({ retiredAt: verifiedAt, updatedAt: verifiedAt }).where(eq(schema.paymentsReceivingAccountOnboarding.id, previous.accountVersionId));
    await expectSql(db.insert(schema.paymentsSepayAccountCutovers).values(cutover(owner, connection)));
    await db.transaction(async (tx) => {
      await tx.update(schema.paymentIntents).set({ state: "expired", closedAt: expiresAt, updatedAt: expiresAt }).where(eq(schema.paymentIntents.id, g.intent.id));
      await tx.update(schema.tips).set({ state: "expired", closedAt: expiresAt, updatedAt: expiresAt }).where(eq(schema.tips.id, g.tip.id));
    });
    const boundary = cutover(owner, connection);
    await db.insert(schema.paymentsSepayAccountCutovers).values(boundary);
    await expectSql(db.transaction((tx) => insertGraph(tx, graph(owner))));
    const intruder = await creator(owner.accountFingerprint);
    await expectSql(db.transaction((tx) => insertGraph(tx, graph(intruder))));
    await expectSql(db.transaction((tx) => insertGraph(tx, graph(intruder, boundary.id))));
    await expectSql(db.delete(schema.paymentsSepayAccountCutovers).where(eq(schema.paymentsSepayAccountCutovers.id, boundary.id)), "55000");
  });

  test("records automatic proof without invented creator assurance and atomically reserves its canonical identity", async () => {
    const f = await providerFixture();
    await expectSql(db.insert(schema.paymentsSepayTransactions).values(f.transaction));
    await expectSql(confirmProvider(f, { actorSessionId: "fake-creator", attestedReceived: true }));
    await expectSql(confirmProvider(f, { workerIdentity: null }));
    await expectSql(confirmProvider(f, {}, { transferAt: at }));
    await expectSql(confirmProvider(f, {}, { amountVnd: 20_000 }));
    await expectSql(confirmProvider(f, {}, { referenceHash: hash() }));
    await expectSql(db.insert(schema.paymentConfirmations).values(manualConfirmation(f.g)));
    await confirmProvider(f);
    const [row] = await db.select().from(schema.paymentConfirmations).where(eq(schema.paymentConfirmations.paymentIntentId, f.g.intent.id));
    expect(row).toMatchObject({ source: "sepay_automatic", actorSessionId: null, primaryAuthenticatedAt: null, bankTransactionFingerprint: null, providerTransactionId: f.transaction.id });
    await expectSql(db.update(schema.paymentIntents).set({ settlementLane: "manual_attested", cutoverId: null }).where(eq(schema.paymentIntents.id, f.g.intent.id)), "55000");
    await expectSql(db.update(schema.paymentsSepayTransactions).set({ providerTransactionId: "222" }).where(eq(schema.paymentsSepayTransactions.id, f.transaction.id)), "55000");
  });

  test("creator review consumes the same canonical transaction key as automatic confirmation", async () => {
    const f = await providerFixture();
    await confirmProvider(f, { source: "creator_reviewed_sepay", workerIdentity: null, actorSessionId: "synthetic-session",
      primaryAuthenticatedAt: at, attestedReceived: true, idempotencyKeyHash: hash() });
    const second = graph(f.owner, f.boundary.id);
    await db.transaction((tx) => insertGraph(tx, second));
    await expectSql(db.insert(schema.paymentsSepayTransactions).values({ ...f.transaction, id: randomUUID(), paymentIntentId: second.intent.id, referenceHash: second.intent.referenceHash }), "23505");
  });

  test.each(["paused", "disconnected", "reconnect_required"])("a %s connection fences new provider intents and stale readback", async (status) => {
    const f = await providerFixture();
    await db.update(schema.paymentsSepayConnections).set({ status, version: 3, updatedAt: verifiedAt }).where(eq(schema.paymentsSepayConnections.id, f.connection.id));
    await expectSql(confirmProvider(f));
    await expectSql(db.transaction((tx) => insertGraph(tx, graph(f.owner, f.boundary.id))));
    await expectSql(db.transaction((tx) => insertGraph(tx, graph(f.owner))));
  });

  test("keeps revisions, accepted bytes, conflicts and review evidence immutable and ignored events minimal", async () => {
    const f = await providerFixture();
    await expectSql(db.update(schema.paymentsSepayConnectionRevisions).set({ scopes: ["company"] }).where(eq(schema.paymentsSepayConnectionRevisions.id, f.connection.revisionId)), "55000");
    await expectSql(db.update(schema.paymentsSepayInbox).set({ normalizedFacts: {} }).where(eq(schema.paymentsSepayInbox.id, f.inboxId)), "55000");
    await db.insert(schema.paymentsSepayInboxConflicts).values({ inboxId: f.inboxId, payloadDigest: `sha256:${"b".repeat(64)}`, receivedAt: verifiedAt });
    await expectSql(confirmProvider(f));
    await expectSql(db.delete(schema.paymentsSepayInboxConflicts).where(eq(schema.paymentsSepayInboxConflicts.inboxId, f.inboxId)), "55000");
    await expectSql(db.insert(schema.paymentsSepayInbox).values({ id: randomUUID(), connectionId: f.connection.id,
      connectionRevisionId: f.connection.revisionId, providerEventId: "0", payloadDigest: digest,
      disposition: "ignored", normalizedFacts: { reason: "mock", accountNumber: "sensitive" }, receivedAt: at }));
    const other = await creator();
    await expectSql(db.insert(schema.paymentsSepayDecisions).values({ id: randomUUID(), inboxId: f.inboxId, action: "dismiss", reason: "Synthetic review",
      actorUserId: other.creatorUserId, actorSessionId: "synthetic-session", idempotencyKeyHash: hash(), expectedVersion: 1, createdAt: verifiedAt }));
  });

  test("authorization attempts bind creator/environment/version and allow exactly one consumption", async () => {
    const owner = await creator(); const connection = await readyConnection(owner); const id = randomUUID();
    const attempt = { id, connectionId: connection.id, stateHash: hash(), actorUserId: owner.creatorUserId,
      actorSessionId: "synthetic-session", providerEnvironment: "test", redirectUri: "https://app.example.invalid/callback",
      codeVerifierEnvelope: envelope("sepay_attempt", id, "code_verifier"), expectedConnectionVersion: 2, createdAt: at,
      expiresAt: new Date(at.getTime() + 600_000) };
    await expectSql(db.insert(schema.paymentsSepayOAuthAttempts).values({ ...attempt, expectedConnectionVersion: 1 }));
    await db.insert(schema.paymentsSepayOAuthAttempts).values(attempt);
    await db.update(schema.paymentsSepayOAuthAttempts).set({ status: "exchanging", consumedAt: cutoverAt }).where(eq(schema.paymentsSepayOAuthAttempts.id, id));
    await expectSql(db.update(schema.paymentsSepayOAuthAttempts).set({ status: "pending", consumedAt: null }).where(eq(schema.paymentsSepayOAuthAttempts.id, id)), "55000");
    await db.update(schema.paymentsSepayOAuthAttempts).set({ status: "completed" }).where(eq(schema.paymentsSepayOAuthAttempts.id, id));
    await expectSql(db.update(schema.paymentsSepayOAuthAttempts).set({ status: "exchanging" }).where(eq(schema.paymentsSepayOAuthAttempts.id, id)), "55000");
  });

  test("upgrades 0026 preserving old payment facts and honestly assigning manual lanes", async () => {
    const owner = await creator(); const g = graph(owner);
    await db.transaction((tx) => insertGraph(tx, g));
    await confirmManual(g);
    const bindings = [["identity_users", "id", owner.creatorUserId], ["payments_receiving_account_onboarding", "id", owner.accountVersionId],
      ["creator_tip_setting_revisions", "id", owner.settingRevisionId], ["creator_tip_settings", "creator_user_id", owner.creatorUserId],
      ["tips", "id", g.tip.id], ["payment_intents", "id", g.intent.id], ["payment_confirmations", "payment_intent_id", g.intent.id]] as const;
    const records = await Promise.all(bindings.map(async ([table, field, id]) => {
      const [result] = await client.unsafe<{ row: Record<string, unknown> }[]>(`select to_jsonb(item) - ARRAY['settlement_lane','cutover_id','provider_transaction_id','worker_identity'] as row from "${table}" item where "${field}" = $1`, [id]);
      return { table, row: result!.row };
    }));
    const upgradeSchema = `${schemaName}_upgrade`; const upgradeJournal = `${upgradeSchema}_journal`;
    const temporary = await mkdtemp(join(tmpdir(), "pawket-sepay-upgrade-"));
    const upgrade = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      await mkdir(join(temporary, "meta"));
      const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8"));
      const entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 26);
      await writeFile(join(temporary, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
      for (const entry of entries) await copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(temporary, `${entry.tag}.sql`));
      await upgrade.unsafe(`create schema "${upgradeSchema}"`);
      await upgrade.unsafe(`set search_path to "${upgradeSchema}", public`);
      const upgradeDb = drizzle(upgrade, { schema });
      await migrate(upgradeDb, { migrationsFolder: temporary, migrationsSchema: upgradeJournal });
      await upgrade.begin(async (tx) => {
        for (const { table, row } of records) {
          const initial = ["tips", "payment_intents"].includes(table) ? { ...row, state: table === "tips" ? "awaiting_payment" : "awaiting_transfer", closed_at: null, updated_at: row.created_at } : row;
          await tx.unsafe(`insert into "${table}" select * from jsonb_populate_record(null::"${table}", $1::jsonb)`, [JSON.stringify(initial)]);
        }
        await tx`update payment_intents set state = 'confirmed', closed_at = ${verifiedAt.toISOString()}::timestamptz, updated_at = ${verifiedAt.toISOString()}::timestamptz`;
        await tx`update tips set state = 'completed', closed_at = ${verifiedAt.toISOString()}::timestamptz, updated_at = ${verifiedAt.toISOString()}::timestamptz`;
      });
      await migrate(upgradeDb, { migrationsFolder, migrationsSchema: upgradeJournal });
      for (const { table, row } of records) {
        const [actual] = await upgrade.unsafe<{ row: Record<string, unknown> }[]>(`select to_jsonb(item) as row from "${table}" item`);
        const added = table === "payment_intents" ? { settlement_lane: "manual_attested", cutover_id: null }
          : table === "payment_confirmations" ? { provider_transaction_id: null, worker_identity: null } : {};
        expect(actual!.row).toEqual({ ...row, ...added });
      }
      await migrate(upgradeDb, { migrationsFolder, migrationsSchema: upgradeJournal });
    } finally {
      await upgrade.unsafe("set search_path to public");
      await upgrade.unsafe(`drop schema if exists "${upgradeSchema}" cascade`);
      await upgrade.unsafe(`drop schema if exists "${upgradeJournal}" cascade`);
      await upgrade.end();
      if (resolve(temporary) !== join(resolve(tmpdir()), basename(temporary)) || !basename(temporary).startsWith("pawket-sepay-upgrade-")) throw new Error("Unsafe temporary migration cleanup path");
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
