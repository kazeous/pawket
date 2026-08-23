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

test("lease migration preserves legacy locks and rejects new locks without expiry", async () => {
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

    for (const migration of upgradeMigrations) {
      await executeMigration(client, migration);
    }

    const [legacyRow] = await client.unsafe<{ lease_expires_at: string | null }[]>(`
      select lease_expires_at
      from system_outbox
      where aggregate_id = 'legacy-locked-1'
    `);
    expect.soft(legacyRow?.lease_expires_at).not.toBeNull();
    expect.soft(new Date(legacyRow?.lease_expires_at ?? 0)).toEqual(
      new Date(legacyLockedAt.getTime() + 5 * 60_000),
    );

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
