import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, describe, expect, test } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database integration tests");

const migrationsFolder = fileURLToPath(new URL("../migrations/", import.meta.url));
const admin = postgres(databaseUrl, { max: 1 });
const createdSchemas: string[] = [];

async function createIsolatedClient(label: string) {
  const schemaName = `payments_migrator_${label}_${process.pid}_${Date.now()}`;
  const journalSchema = `${schemaName}_journal`;
  await admin.unsafe(`create schema "${schemaName}"`);
  createdSchemas.push(schemaName, journalSchema);
  const client = postgres(databaseUrl, { max: 1 });
  await client.unsafe(`set search_path to "${schemaName}", public`);
  return { client, schemaName, journalSchema };
}

async function createMigrationsThrough0008(): Promise<string> {
  const temporaryFolder = await mkdtemp(join(tmpdir(), "pawket-migrations-through-0008-"));
  const metaFolder = join(temporaryFolder, "meta");
  await mkdir(metaFolder);
  const journal = JSON.parse(
    await readFile(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as {
    version: string;
    dialect: string;
    entries: Array<{ idx: number; tag?: string }>;
  };
  const entries = journal.entries.filter((entry) => entry.idx <= 8);
  await writeFile(
    join(metaFolder, "_journal.json"),
    `${JSON.stringify({ ...journal, entries }, null, 2)}\n`,
  );
  for (const entry of entries) {
    if (!entry.tag) throw new Error("Migration journal entry is missing its tag");
    await copyFile(
      join(migrationsFolder, `${entry.tag}.sql`),
      join(temporaryFolder, `${entry.tag}.sql`),
    );
  }
  return temporaryFolder;
}

async function expectPaymentsHead(
  client: postgres.Sql,
  schemaName: string,
  journalSchema: string,
): Promise<void> {
  const [tables] = await client<Record<string, string | null>[]>`
    select
      to_regclass('payments_receiving_account_onboarding')::text as accounts,
      to_regclass('payments_verification_deposit_challenges')::text as challenges,
      to_regclass('payments_verification_deposit_reports')::text as reports,
      to_regclass('payments_verification_deposit_receipts')::text as receipts,
      to_regclass('payments_verification_deposit_refund_obligations')::text as obligations,
      to_regclass('payments_verification_deposit_refunds')::text as refunds,
      to_regclass('payments_unmatched_deposits')::text as unmatched
  `;
  expect(tables).toEqual({
    accounts: "payments_receiving_account_onboarding",
    challenges: "payments_verification_deposit_challenges",
    reports: "payments_verification_deposit_reports",
    receipts: "payments_verification_deposit_receipts",
    obligations: "payments_verification_deposit_refund_obligations",
    refunds: "payments_verification_deposit_refunds",
    unmatched: "payments_unmatched_deposits",
  });

  const triggers = await client<{ trigger_name: string }[]>`
    select trigger_name
    from information_schema.triggers
    where event_object_schema = ${schemaName}
      and trigger_name like 'payments_%_immutable'
    group by trigger_name
    order by trigger_name
  `;
  expect(triggers).toEqual([
    { trigger_name: "payments_receiving_account_binding_immutable" },
    { trigger_name: "payments_refund_obligation_binding_immutable" },
    { trigger_name: "payments_verification_challenge_binding_immutable" },
    { trigger_name: "payments_verification_receipts_immutable" },
    { trigger_name: "payments_verification_refunds_immutable" },
    { trigger_name: "payments_verification_reports_immutable" },
  ]);

  const referencedSchemas = await client<{ schema_name: string }[]>`
    select distinct target_ns.nspname as schema_name
    from pg_constraint constraint_row
    join pg_class source_table on source_table.oid = constraint_row.conrelid
    join pg_namespace source_ns on source_ns.oid = source_table.relnamespace
    join pg_class target_table on target_table.oid = constraint_row.confrelid
    join pg_namespace target_ns on target_ns.oid = target_table.relnamespace
    where constraint_row.contype = 'f'
      and source_ns.nspname = ${schemaName}
      and source_table.relname like 'payments_%'
    order by target_ns.nspname
  `;
  expect(referencedSchemas).toEqual([{ schema_name: schemaName }]);

  const [journal] = await client.unsafe<{ count: number }[]>(
    `select count(*)::int as count from "${journalSchema}"."__drizzle_migrations"`,
  );
  expect(journal?.count).toBe(14);
}

afterAll(async () => {
  for (const schemaName of [...createdSchemas].reverse()) {
    await admin.unsafe(`drop schema if exists "${schemaName}" cascade`);
  }
  await admin.end();
});

describe("configured Drizzle Payments migrator", () => {
  test("migrates a blank database to all Payments tables and immutability triggers", async () => {
    // Break caught: SQL existing on disk but absent from the production Drizzle journal.
    const { client, schemaName, journalSchema } = await createIsolatedClient("blank");
    try {
      await migrate(drizzle(client), { migrationsFolder, migrationsSchema: journalSchema });
      await expectPaymentsHead(client, schemaName, journalSchema);
    } finally {
      await client.end();
    }
  });

  test("upgrades the deployed 0008 creator schema without binding Payments FKs to public", async () => {
    // Break caught: a migration that passes on blank public but targets the wrong schema during upgrade tests.
    const { client, schemaName, journalSchema } = await createIsolatedClient("upgrade");
    const through0008 = await createMigrationsThrough0008();
    try {
      await migrate(drizzle(client), {
        migrationsFolder: through0008,
        migrationsSchema: journalSchema,
      });
      await expect(
        client<{ name: string | null }[]>`
          select to_regclass(${`${schemaName}.payments_receiving_account_onboarding`})::text as name
        `,
      ).resolves.toEqual([{ name: null }]);
      await migrate(drizzle(client), { migrationsFolder, migrationsSchema: journalSchema });
      await expectPaymentsHead(client, schemaName, journalSchema);
    } finally {
      await client.end();
      await rm(through0008, { recursive: true, force: true });
    }
  });
});
