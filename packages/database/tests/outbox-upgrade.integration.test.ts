import { readdir, readFile } from "node:fs/promises";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { expect, test } from "vitest";

import { claimOutboxBatch, systemOutbox } from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) {
  throw new Error("TEST_DATABASE_URL is required for database integration tests");
}

const migrationsDirectory = new URL("../migrations/", import.meta.url);

async function executeMigration(client: postgres.Sql, filename: string): Promise<void> {
  const migration = await readFile(new URL(filename, migrationsDirectory), "utf8");

  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) {
      await client.unsafe(statement);
    }
  }
}

test("shared-control expand migration upgrades 88849bd shape while old outbox code still runs", async () => {
  const schemaName = `outbox_upgrade_${process.pid}_${Date.now()}`;
  const client = postgres(databaseUrl, { max: 1 });
  const legacyLockedAt = new Date("2026-08-23T14:00:00.000Z");

  try {
    await client.unsafe(`create schema "${schemaName}"`);
    await client.unsafe(`set search_path to "${schemaName}", public`);

    const migrationFiles = (await readdir(migrationsDirectory))
      .filter((filename) => filename.endsWith(".sql"))
      .sort();
    const [initialMigration, ...upgradeMigrations] = migrationFiles;

    if (!initialMigration) {
      throw new Error("Initial database migration is required for upgrade testing");
    }

    await executeMigration(client, initialMigration);
    await client.unsafe(`
      insert into system_outbox (
        event_type,
        event_version,
        aggregate_type,
        aggregate_id,
        payload,
        occurred_at,
        available_at,
        locked_at,
        locked_by
      ) values (
        'legacy.locked',
        1,
        'legacy',
        'legacy-locked-1',
        '{}',
        '${legacyLockedAt.toISOString()}'::timestamptz,
        '${legacyLockedAt.toISOString()}'::timestamptz,
        '${legacyLockedAt.toISOString()}'::timestamptz,
        'legacy-worker'
      )
    `);

    const sharedControlMigration = upgradeMigrations.find((migration) =>
      migration.includes("shared-controls"),
    );
    if (!sharedControlMigration) {
      throw new Error("Shared-control expand migration is required for upgrade testing");
    }
    for (const migration of upgradeMigrations.filter(
      (migration) => migration !== sharedControlMigration,
    )) {
      await executeMigration(client, migration);
    }

    // This row represents the already-deployed 88849bd schema immediately before 0003.
    await client.unsafe(`
      insert into system_outbox (
        event_type,
        event_version,
        aggregate_type,
        aggregate_id,
        payload,
        occurred_at,
        available_at
      ) values (
        'baseline.current',
        1,
        'baseline',
        'baseline-88849bd',
        '{"safe":true}',
        '${legacyLockedAt.toISOString()}'::timestamptz,
        '${new Date(legacyLockedAt.getTime() + 86_400_000).toISOString()}'::timestamptz
      )
    `);

    await executeMigration(client, sharedControlMigration);

    const [legacyRow] = await client.unsafe<{ lease_expires_at: string | null }[]>(`
      select lease_expires_at
      from system_outbox
      where aggregate_id = 'legacy-locked-1'
    `);
    expect.soft(legacyRow?.lease_expires_at).not.toBeNull();
    expect.soft(new Date(legacyRow?.lease_expires_at ?? 0)).toEqual(
      new Date(legacyLockedAt.getTime() + 5 * 60_000),
    );

    const [baselineRow] = await client.unsafe<{ payload: Record<string, unknown> }[]>(`
      select payload
      from system_outbox
      where aggregate_id = 'baseline-88849bd'
    `);
    expect.soft(baselineRow?.payload).toEqual({ safe: true });
    const sharedTables = await client.unsafe<{ table_name: string }[]>(`
      select table_name
      from information_schema.tables
      where table_schema = '${schemaName}'
        and table_name in (
          'admin_audit_events',
          'system_command_idempotency',
          'system_business_calendar_versions',
          'system_business_calendar_holidays'
        )
      order by table_name
    `);
    expect.soft(sharedTables.map((row) => row.table_name)).toEqual([
      "admin_audit_events",
      "system_business_calendar_holidays",
      "system_business_calendar_versions",
      "system_command_idempotency",
    ]);

    const isolatedDb = drizzle(client, { schema: { systemOutbox } });
    expect.soft(
      await claimOutboxBatch(isolatedDb, {
        workerId: "new-worker",
        limit: 1,
        leaseMs: 30_000,
        now: new Date(legacyLockedAt.getTime() + 1),
      }),
    ).toEqual([]);

    await client.unsafe(`
      insert into system_outbox (
        event_type,
        event_version,
        aggregate_type,
        aggregate_id,
        payload,
        occurred_at,
        available_at
      ) values (
        'legacy.unlocked',
        1,
        'legacy',
        'legacy-unlocked-1',
        '{}',
        '${legacyLockedAt.toISOString()}'::timestamptz,
        '${legacyLockedAt.toISOString()}'::timestamptz
      )
    `);

    await expect(
      client.unsafe(`
        update system_outbox
        set locked_at = '${legacyLockedAt.toISOString()}'::timestamptz,
            locked_by = 'old-worker'
        where aggregate_id = 'legacy-unlocked-1'
      `),
    ).rejects.toMatchObject({ code: "23514" });
  } finally {
    await client.unsafe("set search_path to public");
    await client.unsafe(`drop schema if exists "${schemaName}" cascade`);
    await client.end();
  }
});
