import { randomUUID } from "node:crypto";
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

function isolatedSchema(label: string): string {
  return `creator_migrator_${label}_${process.pid}_${Date.now()}_${createdSchemas.length}`;
}

async function createIsolatedClient(label: string) {
  const schemaName = isolatedSchema(label);
  const journalSchema = `${schemaName}_journal`;
  await admin.unsafe(`create schema "${schemaName}"`);
  createdSchemas.push(schemaName, journalSchema);
  const client = postgres(databaseUrl, { max: 1 });
  await client.unsafe(`set search_path to "${schemaName}", public`);
  return { client, schemaName, journalSchema };
}

async function expectCreatorHead(
  client: postgres.Sql,
  schemaName: string,
  journalSchema: string,
): Promise<void> {
  const [tables] = await client<{
    applications: string | null;
    revisions: string | null;
    attestations: string | null;
    decisions: string | null;
    capabilities: string | null;
  }[]>`
    select
      to_regclass('creator_applications')::text as applications,
      to_regclass('creator_application_revisions')::text as revisions,
      to_regclass('creator_application_attestations')::text as attestations,
      to_regclass('creator_application_decisions')::text as decisions,
      to_regclass('identity_creator_capabilities')::text as capabilities
  `;
  expect(tables).toEqual({
    applications: "creator_applications",
    revisions: "creator_application_revisions",
    attestations: "creator_application_attestations",
    decisions: "creator_application_decisions",
    capabilities: "identity_creator_capabilities",
  });

  const userId = `migrator-user-${randomUUID()}`;
  const applicationId = randomUUID();
  const submittedRevisionId = randomUUID();
  const draftRevisionId = randomUUID();
  const at = "2026-08-24T03:00:00.000Z";
  await client.unsafe(`
    insert into identity_users
      (id, name, email, canonical_email, email_verified, email_verified_at,
       email_verification_provenance, access_status, authorization_version, created_at, updated_at)
    values
      ('${userId}', 'Migrator User', '${userId}@example.com', '${userId}@example.com', true,
       '${at}', 'password_email_challenge', 'active', 1, '${at}', '${at}')
  `);
  await client.unsafe(`
    insert into creator_applications
      (id, user_id, state, version, current_revision_id, created_at, updated_at)
    values ('${applicationId}', '${userId}', 'submitted', 2, '${submittedRevisionId}', '${at}', '${at}')
  `);
  await client.unsafe(`
    insert into creator_application_revisions
      (id, application_id, revision_number, submitted_at, created_at, updated_at)
    values
      ('${submittedRevisionId}', '${applicationId}', 1, '${at}', '${at}', '${at}'),
      ('${draftRevisionId}', '${applicationId}', 2, null, '${at}', '${at}')
  `);
  await expect(
    client.unsafe(`delete from creator_application_revisions where id = '${submittedRevisionId}'`),
  ).rejects.toThrow("submitted creator application revisions are immutable");
  await client.unsafe(`delete from creator_application_revisions where id = '${draftRevisionId}'`);
  const [remainingDraft] = await client<{ count: number }[]>`
    select count(*)::int as count
    from creator_application_revisions
    where id = ${draftRevisionId}
  `;
  expect(remainingDraft?.count).toBe(0);

  const triggers = await client<{ trigger_name: string }[]>`
    select trigger_name
    from information_schema.triggers
    where event_object_schema = ${schemaName}
      and trigger_name in (
        'creator_application_revisions_immutable',
        'creator_application_attestations_immutable'
      )
    group by trigger_name
    order by trigger_name
  `;
  expect(triggers).toEqual([
    { trigger_name: "creator_application_attestations_immutable" },
    { trigger_name: "creator_application_revisions_immutable" },
  ]);

  const [revisionApplicationIndex] = await client<{ name: string | null }[]>`
    select to_regclass('creator_application_revisions_app_idx')::text as name
  `;
  expect(revisionApplicationIndex?.name).toBe("creator_application_revisions_app_idx");

  const [journal] = await client.unsafe<{ count: number }[]>(
    `select count(*)::int as count from "${journalSchema}"."__drizzle_migrations"`,
  );
  expect(journal?.count).toBe(15);
}

async function createMigrationsThrough0006(): Promise<string> {
  const temporaryFolder = await mkdtemp(join(tmpdir(), "pawket-migrations-through-0006-"));
  const metaFolder = join(temporaryFolder, "meta");
  await mkdir(metaFolder);
  const journalPath = join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
    version: string;
    dialect: string;
    entries: Array<{ idx: number }>;
  };
  await writeFile(
    join(metaFolder, "_journal.json"),
    `${JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx <= 6) }, null, 2)}\n`,
  );
  for (const entry of journal.entries.filter((candidate) => candidate.idx <= 6)) {
    const tag = (entry as { tag?: string }).tag;
    if (!tag) throw new Error("Migration journal entry is missing its tag");
    await copyFile(join(migrationsFolder, `${tag}.sql`), join(temporaryFolder, `${tag}.sql`));
  }
  return temporaryFolder;
}

afterAll(async () => {
  for (const schemaName of [...createdSchemas].reverse()) {
    await admin.unsafe(`drop schema if exists "${schemaName}" cascade`);
  }
  await admin.end();
});

describe("configured Drizzle creator migrator", () => {
  test("migrates a blank database to creator head with all tables, indexes, and triggers", async () => {
    // Break caught: creator SQL files existing on disk without journal entries, so production skips them.
    const { client, schemaName, journalSchema } = await createIsolatedClient("blank");
    try {
      await migrate(drizzle(client), { migrationsFolder, migrationsSchema: journalSchema });
      await expectCreatorHead(client, schemaName, journalSchema);
    } finally {
      await client.end();
    }
  });

  test("uses the configured migrator to upgrade a deployed 0006 database to creator head", async () => {
    // Break caught: creator migrations working only on blank databases or in manual SQL-enumeration tests.
    const { client, schemaName, journalSchema } = await createIsolatedClient("upgrade");
    const through0006 = await createMigrationsThrough0006();
    try {
      await migrate(drizzle(client), {
        migrationsFolder: through0006,
        migrationsSchema: journalSchema,
      });
      await expect(
        client<{ name: string | null }[]>`select to_regclass('identity_users')::text as name`,
      ).resolves.toEqual([{ name: "identity_users" }]);
      await expect(
        client<{ name: string | null }[]>`
          select to_regclass(${`${schemaName}.creator_applications`})::text as name
        `,
      ).resolves.toEqual([{ name: null }]);

      await migrate(drizzle(client), { migrationsFolder, migrationsSchema: journalSchema });
      await expectCreatorHead(client, schemaName, journalSchema);
    } finally {
      await client.end();
      await rm(through0006, { recursive: true, force: true });
    }
  });
});
