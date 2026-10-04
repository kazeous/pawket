import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createCreatorTipPaymentService } from "@pawket/payments";
import { commandIds, createSePayIntegrationFixture, createSePayTestConnection, fixtureHash, schema } from "../../../packages/payments/tests/sepay-integration-fixture.js";

const url = process.env.TEST_DATABASE_URL;
const parsed = new URL(url ?? "invalid:");
if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || !/test|ci/iu.test(parsed.pathname)) throw new Error("Upgrade tests require a dedicated local test database");
const source = createSePayIntegrationFixture("commission_upgrade_source");
const migrationsFolder = fileURLToPath(new URL("../../../packages/database/migrations/", import.meta.url));
beforeAll(source.initialize, 30_000); afterAll(source.dispose, 30_000);

// Fixed identifiers and dependency order. No constraints/triggers are disabled for seeding.
const tables = ["identity_users", "payments_receiving_account_onboarding", "creator_tip_setting_revisions", "creator_tip_settings",
  "payments_sepay_connections", "payments_sepay_connection_revisions", "payments_sepay_account_cutovers", "tips", "payment_intents",
  "payments_sepay_inbox", "payments_sepay_transactions", "payment_confirmations", "payments_sepay_processing", "payments_sepay_decisions"] as const;
type Table = typeof tables[number];
type Row = Record<string, unknown>;
test("0028→0030 preserves pending, confirmed and expired manual/provider tips and accepts old settlement SQL", async () => {
  const manual = await source.creator(); const manualIntent = await manual.createIntent(); manual.advance(1_000);
  const manualService = createCreatorTipPaymentService({ ...manual.common, applicationRevision: "synthetic-i6-upgrade", paymentsMode: "manual_only", pageSize: 25,
    recentAuthMs: 900_000, mfaAuthMs: 300_000, assurance: manual.assurance,
    tips: { ...manual.tips, getConfirmedGuestContent: async () => ({ name: "Synthetic buyer", message: "Synthetic upgrade" }) } });
  await manualService.confirm({ actor: manual.actor, paymentIntentId: manualIntent.id, observedAmountVnd: manualIntent.amountVnd,
    observedTransferReference: manualIntent.reference, observedBankTransactionId: randomUUID(), attestedReceived: true, ...commandIds() });
  const pending = await manual.createIntent();
  const provider = await source.creator(); const connected = await provider.connect(); const cutover = await provider.cutover(); provider.advance(1_000);
  const providerIntent = await provider.createIntent(cutover.id); provider.advance(1_000);
  await provider.inbox.receive(provider.signed(connected.connection.id, connected.secret, provider.event(providerIntent.reference)));
  const [inbox] = await source.db.select().from(schema.paymentsSepayInbox).where(eq(schema.paymentsSepayInbox.connectionId, connected.connection.id));
  expect(await provider.reconciliation.processInbox(inbox!.id)).toBe("confirmed");
  await provider.createIntent(cutover.id);
  const expiredManual = await manual.createIntent(); const expiredProvider = await provider.createIntent(cutover.id);
  for (const expired of [expiredManual, expiredProvider]) await source.db.transaction(async (tx) => {
    await tx.update(schema.paymentIntents).set({ state: "expired", closedAt: expired.expiresAt, updatedAt: expired.expiresAt }).where(eq(schema.paymentIntents.id, expired.id));
    await tx.update(schema.tips).set({ state: "expired", closedAt: expired.expiresAt, updatedAt: expired.expiresAt }).where(eq(schema.tips.id, expired.tipId));
  });
  const captured = new Map<Table, Row[]>();
  for (const table of tables) {
    const rows = await source.client.unsafe<{ row: Row }[]>(`select to_jsonb(item) ${table === "payment_intents" ? "- 'commission_order_id'" : ""} as row from "${table}" item order by to_jsonb(item)::text`);
    captured.set(table, rows.map((item) => item.row));
  }
  const name = `commission_upgrade_${process.pid}_${Date.now()}`; const journalName = `${name}_journal`;
  const temporary = await mkdtemp(join(tmpdir(), "pawket-i6-upgrade-"));
  const client = createSePayTestConnection(); const db = drizzle(client, { schema });
  try {
    await mkdir(join(temporary, "meta"));
    const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8"));
    const entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 28);
    await writeFile(join(temporary, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
    for (const entry of entries) await copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(temporary, `${entry.tag}.sql`));
    await client.unsafe(`create schema "${name}"`); await client.unsafe(`set search_path to "${name}", public`);
    await migrate(db, { migrationsFolder: temporary, migrationsSchema: journalName });
    await client.begin(async (tx) => {
      for (const table of tables) {
        for (const row of captured.get(table)!) {
          const initial = table === "payments_sepay_connections" ? { ...row, status: "setup_pending", current_revision_id: null, version: Number(row.version) - 1 }
            : table === "tips" ? { ...row, state: "awaiting_payment", closed_at: null, updated_at: row.created_at }
            : table === "payment_intents" ? { ...row, state: "awaiting_transfer", closed_at: null, updated_at: row.created_at } : row;
          await tx.unsafe(`insert into "${table}" select * from jsonb_populate_record(null::"${table}", $1::jsonb)`, [JSON.stringify(initial)]);
        }
        if (table === "payments_sepay_connection_revisions") for (const row of captured.get("payments_sepay_connections")!) {
          await tx`update payments_sepay_connections set status = ${String(row.status)}, current_revision_id = ${String(row.current_revision_id)}, version = ${Number(row.version)} where id = ${String(row.id)}`;
        }
        if (table === "payment_confirmations") {
          for (const row of captured.get("payment_intents")!.filter((item) => item.state !== "awaiting_transfer")) {
            await tx`update payment_intents set state = ${String(row.state)}, closed_at = ${String(row.closed_at)}::timestamptz, updated_at = ${String(row.updated_at)}::timestamptz where id = ${String(row.id)}`;
          }
          for (const row of captured.get("tips")!.filter((item) => item.state !== "awaiting_payment")) {
            await tx`update tips set state = ${String(row.state)}, closed_at = ${String(row.closed_at)}::timestamptz, updated_at = ${String(row.updated_at)}::timestamptz where id = ${String(row.id)}`;
          }
        }
      }
    });
    const snapshot = async () => Promise.all(tables.map(async (table) => {
      const result = await client.unsafe<{ row: Row }[]>(`select to_jsonb(item) - 'commission_order_id' as row from "${table}" item order by to_jsonb(item)::text`);
      return [table, result.map((item) => item.row)];
    }));
    const before = await snapshot();
    expect(before).toEqual([...captured.entries()]);
    await migrate(db, { migrationsFolder, migrationsSchema: journalName });
    expect(await snapshot()).toEqual(before);
    expect(await client`select count(*)::int as count from commission_orders`).toEqual([{ count: 0 }]);
    expect(await client`select purpose, count(*)::int as count from payment_intents where commission_order_id is null group by purpose`).toEqual([{ purpose: "tip", count: 6 }]);
    // I5 confirmation columns/updates remain usable when commission creation is off.
    const template = captured.get("payment_confirmations")!.find((row) => row.payment_intent_id === manualIntent.id)!;
    const confirmationId = randomUUID(); const at = new Date(manual.now().getTime() + 1_000).toISOString();
    await client.begin(async (tx) => {
      await tx.unsafe("insert into payment_confirmations select * from jsonb_populate_record(null::payment_confirmations, $1::jsonb)", [JSON.stringify({ ...template,
        id: confirmationId, payment_intent_id: pending.id, reference_hash: pending.referenceHash, bank_transaction_fingerprint: fixtureHash(),
        confirmed_at: at, request_id: randomUUID(), idempotency_key_hash: fixtureHash() })]);
      await tx`update payment_intents set state = 'confirmed', closed_at = ${at}::timestamptz, updated_at = ${at}::timestamptz where id = ${pending.id}`;
      await tx`update tips set state = 'completed', closed_at = ${at}::timestamptz, updated_at = ${at}::timestamptz where id = ${pending.tipId}`;
    });
    expect(await client`select state from tips where id = ${pending.tipId}`).toEqual([{ state: "completed" }]);
    await migrate(db, { migrationsFolder, migrationsSchema: journalName });
    expect(await client`select count(*)::int as count from payment_confirmations`).toEqual([{ count: 3 }]);
  } finally {
    await client.unsafe("set search_path to public"); await client.unsafe(`drop schema if exists "${name}" cascade`);
    await client.unsafe(`drop schema if exists "${journalName}" cascade`);
    await client.end();
    if (resolve(temporary) !== join(resolve(tmpdir()), basename(temporary)) || !basename(temporary).startsWith("pawket-i6-upgrade-")) throw new Error("Unsafe temporary migration cleanup path");
    await rm(temporary, { recursive: true, force: true });
  }
}, 30_000);
