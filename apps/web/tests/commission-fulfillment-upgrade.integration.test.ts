import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createCreatorCommissionPaymentService } from "@pawket/payments";
import { commandIds, createSePayTestConnection, fixtureEnvelope, fixtureHash, schema } from "../../../packages/payments/tests/sepay-integration-fixture.js";
import { createCommissionOrderTestFixture } from "./commission-order-test-support.js";

const parsed = new URL(process.env.TEST_DATABASE_URL ?? "invalid:");
if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || !/test|ci/iu.test(parsed.pathname)) throw new Error("Fulfillment upgrade tests require a dedicated local test database");
const source = createCommissionOrderTestFixture("commission_fulfillment_upgrade_source");
beforeAll(source.initialize, 30_000); afterAll(source.dispose, 30_000);
const migrationsFolder = fileURLToPath(new URL("../../../packages/database/migrations/", import.meta.url));
const tables = ["identity_users", "payments_receiving_account_onboarding", "creator_tip_setting_revisions", "creator_tip_settings", "commission_policy_revisions",
  "creator_pages", "creator_publication_revisions", "creator_commission_settings", "commission_packages", "commission_package_revisions", "commission_orders",
  "commission_briefs", "commission_quote_revisions", "commission_terms_snapshots", "commission_acceptances", "commission_reservations", "commission_events", "payment_intents", "payment_confirmations"] as const;
type Table = typeof tables[number];
type Row = Record<string, unknown>;
type UpgradeTransaction = Pick<ReturnType<typeof createSePayTestConnection>, "unsafe">;
const envelope = (type: string, id: string, field: string) => fixtureEnvelope(type, id, field, "Synthetic private text");
async function insertJson(tx: UpgradeTransaction, table: Table, row: Row) {
  await tx.unsafe(`insert into "${table}" select * from jsonb_populate_record(null::"${table}", $1::jsonb)`, [JSON.stringify(row)]);
}
async function recordEvent(tx: UpgradeTransaction, orderId: string, version: number, state: string, at: string) {
  await tx.unsafe("insert into commission_events (id, order_id, order_version, type, request_id, occurred_at) values ($1, $2, $3, $4, $5, $6)",
    [randomUUID(), orderId, version, state, randomUUID(), at]);
}

test("0040 to current preserves populated I6 orders and enables fulfillment under normal triggers", async () => {
  const orderIds = new Map<string, string>();
  for (const state of ["requested", "quoted", "awaiting_payment", "in_progress", "closed_before", "closed_after"] as const) {
    const s = await source.setup(state === "quoted" ? "custom_quote" : state === "requested" || state === "closed_before" ? "fixed_approval" : "fixed_immediate");
    const orderId = await s.service.request(s.request()); orderIds.set(state, orderId);
    s.creator.advance(1_000);
    if (state === "quoted") await s.service.quote({ actor: s.creator.actor, orderId, expectedVersion: 1, terms: s.terms, ttlMs: 7 * 86_400_000, ...commandIds() });
    if (state.startsWith("closed")) await s.service.close({ actor: s.buyerActor, orderId, expectedVersion: 1, ...commandIds() });
    if (state === "in_progress") {
      const order = await s.service.getOrder({ actor: s.buyerActor, orderId });
      const payments = createCreatorCommissionPaymentService({ ...s.creator.common, applicationRevision: "synthetic-i7-upgrade", paymentsMode: "manual_only",
        recentAuthMs: 900_000, mfaAuthMs: 300_000, assurance: s.creator.assurance, commissions: s.service.paymentsLifecycle });
      await payments.confirm({ actor: s.creator.actor, paymentIntentId: order.payment!.id, observedAmountVnd: order.payment!.amountVnd,
        observedTransferReference: order.payment!.reference, observedBankTransactionId: randomUUID(), attestedReceived: true, ...commandIds() });
    }
  }
  const captured = new Map<Table, Row[]>();
  for (const table of tables) {
    const rows = await source.client.unsafe<{ row: Row }[]>(`select to_jsonb(item) as row from "${table}" item ${table === "commission_policy_revisions" ? "where id = $1" : ""} order by to_jsonb(item)::text`, table === "commission_policy_revisions" ? [source.policyId] : []);
    captured.set(table, rows.map((item) => item.row));
  }
  const originalOrders = captured.get("commission_orders")!;
  expect(originalOrders.map((row) => row.state).sort()).toEqual(["awaiting_payment", "closed", "closed", "in_progress", "quoted", "requested"]);
  expect(captured.get("commission_reservations")!.map((row) => row.state).sort()).toEqual(["occupied", "released", "reserved"]);
  expect(captured.get("payment_confirmations")).toHaveLength(1);
  const name = `commission_fulfillment_upgrade_${process.pid}_${Date.now()}`; const journalName = `${name}_journal`;
  const temporary = await mkdtemp(join(tmpdir(), "pawket-i7-fulfillment-upgrade-"));
  const client = createSePayTestConnection(); const db = drizzle(client, { schema });
  try {
    await mkdir(join(temporary, "meta"));
    const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
    const entries = journal.entries.filter((entry) => entry.idx <= 40);
    expect(entries.at(-1)?.idx).toBe(40);
    await writeFile(join(temporary, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
    for (const entry of entries) await copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(temporary, `${entry.tag}.sql`));
    await client.unsafe(`create schema "${name}"`); await client.unsafe(`set search_path to "${name}", public`);
    await migrate(db, { migrationsFolder: temporary, migrationsSchema: journalName });
    await client.begin(async (tx) => {
      // Setup only: populated historical rows cannot use the initial-state guards.
      await tx`set local session_replication_role = replica`;
      for (const table of tables) for (const row of captured.get(table)!) await insertJson(tx, table, row);
    });
    expect(await client`show session_replication_role`).toEqual([{ session_replication_role: "origin" }]);
    const legacy = await client<{ id: string; state: string; version: number }[]>`select id, state, version from commission_orders order by id`;
    expect(legacy).toEqual(originalOrders.map((row) => ({ id: row.id, state: row.state, version: row.version })).sort((a, b) => String(a.id).localeCompare(String(b.id))));
    expect(await client`select count(*)::int as count from information_schema.columns where table_schema = ${name} and table_name = 'commission_orders' and column_name = 'revisions_used'`).toEqual([{ count: 0 }]);
    await migrate(db, { migrationsFolder, migrationsSchema: journalName });
    expect(await client`select id, state, version from commission_orders order by id`).toEqual(legacy);
    expect(await client`select count(*)::int as count from commission_orders where revisions_used = 0 and delivered_at is null and review_ends_at is null and completed_at is null and completion_kind is null`).toEqual([{ count: 6 }]);
    for (const table of tables) {
      const rows = await client.unsafe<{ row: Row }[]>(`select to_jsonb(item) as row from "${table}" item ${table === "commission_policy_revisions" ? "where id = $1" : ""} order by to_jsonb(item)::text`, table === "commission_policy_revisions" ? [source.policyId] : []);
      // Compare privately, so a regression cannot print encrypted/private records.
      expect(JSON.stringify(rows.map((item) => item.row)) === JSON.stringify(captured.get(table))).toBe(true);
    }
    const targets = await client`select target_ns.nspname from pg_constraint c join pg_class target on target.oid = c.confrelid
      join pg_namespace target_ns on target_ns.oid = target.relnamespace where c.conrelid = 'commission_submissions'::regclass and c.contype = 'f'`;
    expect(targets).toEqual([{ nspname: name }]);
    const originalId = orderIds.get("in_progress")!;
    const paid = originalOrders.find((row) => row.id === originalId)!;
    const deliveredAt = new Date(new Date(String(paid.confirmed_at)).getTime() + 10 * 86_400_000).toISOString();
    const completedAt = new Date(new Date(deliveredAt).getTime() + 1_000).toISOString();
    async function deliver(orderId: string) {
      await client.begin(async (tx) => {
        const [order] = await tx`update commission_orders set state = 'delivered', version = version + 1, delivered_at = ${deliveredAt},
          review_ends_at = ${new Date(new Date(deliveredAt).getTime() + 7 * 86_400_000).toISOString()}, updated_at = ${deliveredAt} where id = ${orderId} returning version`;
        await tx`insert into commission_submissions (id, order_id, kind, actor_session_id, request_id, submitted_at)
          values (${randomUUID()}, ${orderId}, 'final', 'synthetic-creator', ${randomUUID()}, ${deliveredAt})`;
        await recordEvent(tx, orderId, Number(order!.version), "delivered", deliveredAt);
      });
    }
    async function complete(orderId: string) {
      await client.begin(async (tx) => {
        const [order] = await tx`update commission_orders set state = 'completed', version = version + 1, completed_at = ${completedAt}, completion_kind = 'buyer_accepted', updated_at = ${completedAt} where id = ${orderId} returning version`;
        await tx`update commission_reservations set state = 'completed', released_at = ${completedAt} where order_id = ${orderId}`;
        await recordEvent(tx, orderId, Number(order!.version), "completed", completedAt);
      });
    }
    async function pendingClone() {
      const id = randomUUID(); const intentId = randomUUID(); const referenceHash = fixtureHash();
      await client.begin(async (tx) => {
        await insertJson(tx, "commission_orders", { ...paid, id, state: "awaiting_payment", version: 1, confirmed_at: null, due_at: null, updated_at: paid.created_at });
        const brief = captured.get("commission_briefs")!.find((row) => row.order_id === originalId)!;
        await insertJson(tx, "commission_briefs", { ...brief, order_id: id, request_id: randomUUID(), text_envelope: envelope("commission_briefs", id, "text"), links_envelope: envelope("commission_briefs", id, "links") });
        for (const row of captured.get("commission_acceptances")!.filter((item) => item.order_id === originalId)) await insertJson(tx, "commission_acceptances", { ...row, id: randomUUID(), order_id: id, request_id: randomUUID() });
        const snapshot = captured.get("commission_terms_snapshots")!.find((row) => row.order_id === originalId)!;
        await insertJson(tx, "commission_terms_snapshots", { ...snapshot, order_id: id, scope_envelope: envelope("commission_terms_snapshots", id, "scope"), deliverables_envelope: envelope("commission_terms_snapshots", id, "deliverables"), usage_rights_envelope: envelope("commission_terms_snapshots", id, "usage_rights"), artist_terms_envelope: envelope("commission_terms_snapshots", id, "artist_terms") });
        const reservation = captured.get("commission_reservations")!.find((row) => row.order_id === originalId)!;
        await insertJson(tx, "commission_reservations", { ...reservation, order_id: id, state: "reserved", occupied_at: null });
        await recordEvent(tx, id, 1, "awaiting_payment", String(paid.created_at));
        const intent = captured.get("payment_intents")!.find((row) => row.commission_order_id === originalId)!;
        await insertJson(tx, "payment_intents", { ...intent, id: intentId, commission_order_id: id, reference_hash: referenceHash, reference_envelope: envelope("payment_intents", intentId, "transfer_reference"), destination_envelope: envelope("payment_intents", intentId, "destination"), state: "awaiting_transfer", closed_at: null, updated_at: intent.created_at, request_id: randomUUID() });
      });
      return { id, intentId, referenceHash };
    }
    await deliver(originalId);
    expect(await client`select state from commission_orders where id = ${originalId}`).toEqual([{ state: "delivered" }]);
    await complete(originalId);
    for (let i = 0; i < 2; i++) {
      const f = await pendingClone();
      await client.begin(async (tx) => {
        const confirmation = captured.get("payment_confirmations")![0]!;
        await insertJson(tx, "payment_confirmations", { ...confirmation, id: randomUUID(), payment_intent_id: f.intentId, reference_hash: f.referenceHash, bank_transaction_fingerprint: fixtureHash(), request_id: randomUUID(), idempotency_key_hash: fixtureHash() });
        await tx`update payment_intents set state = 'confirmed', closed_at = ${String(paid.confirmed_at)}, updated_at = ${String(paid.confirmed_at)} where id = ${f.intentId}`;
        await tx`update commission_orders set state = 'in_progress', version = 2, confirmed_at = ${String(paid.confirmed_at)}, due_at = ${String(paid.due_at)}, updated_at = ${String(paid.confirmed_at)} where id = ${f.id}`;
        await tx`update commission_reservations set state = 'occupied', occupied_at = ${String(paid.confirmed_at)} where order_id = ${f.id}`;
        await recordEvent(tx, f.id, 2, "in_progress", String(paid.confirmed_at));
      });
      await deliver(f.id); await complete(f.id);
    }
    expect(await client`select count(*)::int as count from commission_orders where creator_user_id = ${String(paid.creator_user_id)} and buyer_user_id = ${String(paid.buyer_user_id)} and state = 'completed'`).toEqual([{ count: 3 }]);
    const fourth = await pendingClone();
    expect(await client`select state from commission_orders where id = ${fourth.id}`).toEqual([{ state: "awaiting_payment" }]);
    await migrate(db, { migrationsFolder, migrationsSchema: journalName });
  } finally {
    await client.unsafe("set search_path to public"); await client.unsafe(`drop schema if exists "${name}" cascade`);
    await client.unsafe(`drop schema if exists "${journalName}" cascade`); await client.end();
    if (resolve(temporary) !== join(resolve(tmpdir()), basename(temporary)) || !basename(temporary).startsWith("pawket-i7-fulfillment-upgrade-")) throw new Error("Unsafe temporary migration cleanup path");
    await rm(temporary, { recursive: true, force: true });
  }
}, 30_000);
