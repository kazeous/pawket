import { readdir, readFile } from "node:fs/promises";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import * as database from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database integration tests");

const schemaName = `identity_schema_${process.pid}_${Date.now()}`;
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
  for (const migration of migrations) await executeMigration(migration);
});

afterAll(async () => {
  await client.unsafe("set search_path to public");
  await client.unsafe(`drop schema if exists "${schemaName}" cascade`);
  await client.end();
});

describe("identity persistence schema", () => {
  test("exports and migrates every authoritative identity record", async () => {
    const expectedTables = [
      "identity_accounts",
      "identity_creator_capabilities",
      "identity_creator_capability_events",
      "identity_email_addresses",
      "identity_email_handoffs",
      "identity_external_link_transactions",
      "identity_recovery_codes",
      "identity_role_grants",
      "identity_security_throttles",
      "identity_sessions",
      "identity_step_up_proofs",
      "identity_totp_authenticators",
      "identity_users",
      "identity_verifications",
    ];
    const rows = await client<{ table_name: string }[]>`
      select table_name
      from information_schema.tables
      where table_schema = ${schemaName}
        and table_name like 'identity_%'
      order by table_name
    `;

    expect(rows.map((row) => row.table_name)).toEqual(expectedTables);
    for (const exportName of [
      "identityAccounts",
      "identityCreatorCapabilities",
      "identityCreatorCapabilityEvents",
      "identityEmailAddresses",
      "identityEmailHandoffs",
      "identityExternalLinkTransactions",
      "identityRecoveryCodes",
      "identityRoleGrants",
      "identitySecurityThrottles",
      "identitySessions",
      "identityStepUpProofs",
      "identityTotpAuthenticators",
      "identityUsers",
      "identityVerifications",
    ]) {
      expect(database).toHaveProperty(exportName);
    }
  });

  test("enforces canonical email ownership and hash-only session/challenge storage", async () => {
    const columns = await client<{ table_name: string; column_name: string }[]>`
      select table_name, column_name
      from information_schema.columns
      where table_schema = ${schemaName}
        and table_name in ('identity_users', 'identity_sessions', 'identity_verifications')
      order by table_name, column_name
    `;
    const names = columns.map((row) => `${row.table_name}.${row.column_name}`);

    expect(names).toContain("identity_users.canonical_email");
    expect(names).toContain("identity_users.email_verification_provenance");
    expect(names).toContain("identity_users.two_factor_enabled");
    expect(names).toContain("identity_sessions.token_hash");
    expect(names).not.toContain("identity_sessions.token");
    expect(names).toContain("identity_verifications.token_hash");
    expect(names).not.toContain("identity_verifications.value");
  });

  test("stores only protected TOTP, recovery, OAuth state, and step-up evidence", async () => {
    const columns = await client<{ table_name: string; column_name: string }[]>`
      select table_name, column_name
      from information_schema.columns
      where table_schema = ${schemaName}
        and table_name in (
          'identity_totp_authenticators',
          'identity_recovery_codes',
          'identity_external_link_transactions',
          'identity_step_up_proofs'
        )
      order by table_name, column_name
    `;
    const names = columns.map((row) => `${row.table_name}.${row.column_name}`);

    expect(names).toContain("identity_totp_authenticators.secret_envelope");
    expect(names).not.toContain("identity_totp_authenticators.secret");
    expect(names).toContain("identity_recovery_codes.code_hash");
    expect(names).not.toContain("identity_recovery_codes.code");
    expect(names).toContain("identity_external_link_transactions.state_hash");
    expect(names).not.toContain("identity_external_link_transactions.state");
    expect(names).toContain("identity_step_up_proofs.assurance_method");
  });

  test("database checks reject an invalid access state and inconsistent session expiry", async () => {
    await expect(
      client.unsafe(`
        insert into identity_users
          (id, name, email, canonical_email, email_verified, access_status, authorization_version,
           created_at, updated_at)
        values
          ('user-invalid', 'Artist', 'artist@example.com', 'artist@example.com', false,
           'unknown', 1, now(), now())
      `),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
