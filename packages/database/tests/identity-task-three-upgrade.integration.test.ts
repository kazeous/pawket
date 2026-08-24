import { readdir, readFile } from "node:fs/promises";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database integration tests");

const schemaName = `identity_task_three_upgrade_${process.pid}_${Date.now()}`;
const client = postgres(databaseUrl, { max: 1 });
const migrationsDirectory = new URL("../migrations/", import.meta.url);

async function executeMigration(filename: string): Promise<void> {
  const migration = await readFile(new URL(filename, migrationsDirectory), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.unsafe(statement);
  }
}

beforeAll(async () => {
  await client.unsafe(`create schema "${schemaName}"`);
  await client.unsafe(`set search_path to "${schemaName}", public`);
  const migrations = (await readdir(migrationsDirectory))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();
  for (const migration of migrations.filter((filename) => filename < "0006_")) {
    await executeMigration(migration);
  }

  await client.unsafe(`
    insert into identity_users
      (id, name, email, canonical_email, email_verified, email_verified_at,
       email_verification_provenance, access_status, authorization_version, created_at, updated_at)
    values
      ('legacy-credential-user', 'Legacy Artist', 'legacy@example.com', 'legacy@example.com', true,
       '2026-08-24T00:00:00.000Z', 'password_email_challenge', 'active', 1,
       '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')
  `);
  await client.unsafe(`
    insert into identity_accounts
      (id, account_id, provider_id, user_id, password_hash, password_hash_version, created_at, updated_at)
    values
      ('legacy-credential-account', 'legacy-credential-user', 'credential', 'legacy-credential-user',
       'argon2id:legacy-test-hash', 1, '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')
  `);

  await executeMigration(migrations.find((filename) => filename.startsWith("0006_"))!);
});

afterAll(async () => {
  await client.unsafe("set search_path to public");
  await client.unsafe(`drop schema if exists "${schemaName}" cascade`);
  await client.end();
});

describe("Task 3 identity expand migration", () => {
  test("backfills deployed credential issuers before validating the new namespace", async () => {
    const [legacy] = await client<{ issuer: string }[]>`
      select issuer from identity_accounts where id = 'legacy-credential-account'
    `;
    expect(legacy?.issuer).toBe("local:credential");

    await client.unsafe(`
      insert into identity_users
        (id, name, email, canonical_email, email_verified, email_verified_at,
         email_verification_provenance, access_status, authorization_version, created_at, updated_at)
      values
        ('coexisting-old-user', 'Old Revision', 'old-revision@example.com',
         'old-revision@example.com', true, '2026-08-24T00:00:00.000Z',
         'password_email_challenge', 'active', 1,
         '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')
    `);
    await client.unsafe(`
      insert into identity_accounts
        (id, account_id, provider_id, user_id, password_hash, password_hash_version, created_at, updated_at)
      values
        ('coexisting-old-account', 'coexisting-old-user', 'credential', 'coexisting-old-user',
         'argon2id:old-revision-test-hash', 1,
         '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')
    `);
    const [coexisting] = await client<{ issuer: string }[]>`
      select issuer from identity_accounts where id = 'coexisting-old-account'
    `;
    expect(coexisting?.issuer).toBe("local:credential");
  });
});
