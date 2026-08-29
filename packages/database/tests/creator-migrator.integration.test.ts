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
    catalogPages: string | null;
    catalogRevisions: string | null;
    revisions: string | null;
    attestations: string | null;
    decisions: string | null;
    capabilities: string | null;
  }[]>`
    select
      to_regclass('creator_applications')::text as applications,
      to_regclass('creator_pages')::text as "catalogPages",
      to_regclass('creator_publication_revisions')::text as "catalogRevisions",
      to_regclass('creator_application_revisions')::text as revisions,
      to_regclass('creator_application_attestations')::text as attestations,
      to_regclass('creator_application_decisions')::text as decisions,
      to_regclass('identity_creator_capabilities')::text as capabilities
  `;
  expect(tables).toEqual({
    applications: "creator_applications",
    catalogPages: "creator_pages",
    catalogRevisions: "creator_publication_revisions",
    revisions: "creator_application_revisions",
    attestations: "creator_application_attestations",
    decisions: "creator_application_decisions",
    capabilities: "identity_creator_capabilities",
  });

  const userId = `migrator-user-${randomUUID()}`;
  const applicationId = randomUUID();
  const submittedRevisionId = randomUUID();
  const draftRevisionId = randomUUID();
  const partialMinimizationRevisionId = randomUUID();
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
    values ('${applicationId}', '${userId}', 'withdrawn', 2, '${submittedRevisionId}', '${at}', '${at}')
  `);
  await client.unsafe(`
    insert into creator_application_revisions
      (id, application_id, revision_number, artist_display_name, short_introduction,
       applicant_email, dob_envelope, portfolio_urls, primary_art_discipline,
       practice_description, content_intent, proposed_receiving_account_id,
       age_at_submission, age_evaluated_on, submitted_at, created_at, updated_at)
    values
      ('${submittedRevisionId}', '${applicationId}', 1, 'Migrator Artist', 'Introduction',
       '${userId}@example.com', '{"version":1}'::jsonb, '["https://example.com/portfolio"]'::jsonb,
       'illustration', 'Practice', 'general_audience_only', 'receiving-account-1',
       21, '2026-08-24', '${at}', '${at}', '${at}'),
      ('${draftRevisionId}', '${applicationId}', 2, null, null, null, null, null, null,
       null, null, null, null, null, null, '${at}', '${at}')
  `);
  await expect(
    client.unsafe(`
      insert into creator_application_revisions
        (id, application_id, revision_number, artist_display_name, submitted_at, created_at, updated_at)
      values ('${randomUUID()}', '${applicationId}', 3, 'Partial submitted', '${at}', '${at}', '${at}')
    `),
  ).rejects.toThrow();
  await expect(
    client.unsafe(`
      insert into creator_application_revisions
        (id, application_id, revision_number, artist_display_name, short_introduction,
         applicant_email, dob_envelope, portfolio_urls, primary_art_discipline,
         practice_description, content_intent, proposed_receiving_account_id,
         age_at_submission, age_evaluated_on, created_at, updated_at)
      values ('${partialMinimizationRevisionId}', '${applicationId}', 4,
        'Draft Artist', 'Introduction', '${userId}@example.com', '{"version":1}'::jsonb,
        '["https://example.com/draft"]'::jsonb, 'illustration', 'Practice',
        'general_audience_only', 'receiving-account-1', 21, '2026-08-24', '${at}', '${at}')
    `),
  ).resolves.toBeDefined();
  await expect(
    client.unsafe(`
      update creator_application_revisions
      set artist_display_name = null, minimized_at = '${at}'
      where id = '${partialMinimizationRevisionId}'
    `),
  ).rejects.toThrow();
  await expect(
    client.unsafe(`delete from creator_application_revisions where id = '${submittedRevisionId}'`),
  ).rejects.toThrow("submitted creator application revisions are immutable");
  await client.unsafe(`delete from creator_application_revisions where id = '${draftRevisionId}'`);
  await client.unsafe(
    `delete from creator_application_revisions where id = '${partialMinimizationRevisionId}'`,
  );
  const [remainingDraft] = await client<{ count: number }[]>`
    select count(*)::int as count
    from creator_application_revisions
    where id = ${draftRevisionId}
  `;
  expect(remainingDraft?.count).toBe(0);
  await expect(
    client.unsafe(`
      update creator_application_revisions
      set artist_display_name = null, short_introduction = null, applicant_email = null,
          dob_envelope = null, portfolio_urls = null, primary_art_discipline = null,
          practice_description = null, content_intent = null,
          proposed_receiving_account_id = null, minimized_at = '${at}', updated_at = '${at}'
      where id = '${submittedRevisionId}'
    `),
  ).resolves.toBeDefined();
  const [minimizedRevision] = await client<{
    artist_display_name: string | null;
    age_at_submission: number | null;
    minimized_at: Date | null;
  }[]>`
    select artist_display_name, age_at_submission, minimized_at
    from creator_application_revisions
    where id = ${submittedRevisionId}
  `;
  expect(minimizedRevision).toMatchObject({
    artist_display_name: null,
    age_at_submission: 21,
  });
  expect(new Date(String(minimizedRevision?.minimized_at)).toISOString()).toBe(at);

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
  expect(journal?.count).toBe(21);
}

async function createMigrationsThrough(maximumIndex: number): Promise<string> {
  const temporaryFolder = await mkdtemp(
    join(tmpdir(), `pawket-migrations-through-${String(maximumIndex).padStart(4, "0")}-`),
  );
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
    `${JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx <= maximumIndex) }, null, 2)}\n`,
  );
  for (const entry of journal.entries.filter((candidate) => candidate.idx <= maximumIndex)) {
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
    const through0006 = await createMigrationsThrough(6);
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

  test("upgrades the configured journal from index 19 to creator catalog index 20", async () => {
    // Break caught: a catalog migration that runs in ad-hoc SQL tests but is skipped
    // by the configured migrator after an already-deployed 0019 database.
    const { client, schemaName, journalSchema } = await createIsolatedClient("catalog-upgrade");
    const through0019 = await createMigrationsThrough(19);
    try {
      await migrate(drizzle(client), {
        migrationsFolder: through0019,
        migrationsSchema: journalSchema,
      });
      const [before] = await client.unsafe<{ count: number }[]>(
        `select count(*)::int as count from "${journalSchema}"."__drizzle_migrations"`,
      );
      expect(before?.count).toBe(20);
      await expect(
        client<{ name: string | null }[]>`select to_regclass(${`${schemaName}.creator_pages`})::text as name`,
      ).resolves.toEqual([{ name: null }]);

      await migrate(drizzle(client), { migrationsFolder, migrationsSchema: journalSchema });
      await expect(
        client<{ name: string | null }[]>`select to_regclass('creator_pages')::text as name`,
      ).resolves.toEqual([{ name: "creator_pages" }]);
      const [after] = await client.unsafe<{ count: number }[]>(
        `select count(*)::int as count from "${journalSchema}"."__drizzle_migrations"`,
      );
      expect(after?.count).toBe(21);
    } finally {
      await client.end();
      await rm(through0019, { recursive: true, force: true });
    }
  });

  test("upgrades complete legacy submitted revisions and rejects newly partial submissions", async () => {
    // Break caught: the new completeness check either blocking valid deployed rows
    // during upgrade or allowing partial submitted rows after migration 0018.
    const { client, journalSchema } = await createIsolatedClient("task9-upgrade");
    const through0017 = await createMigrationsThrough(17);
    const userId = `task9-legacy-user-${randomUUID()}`;
    const applicationId = randomUUID();
    const revisionId = randomUUID();
    const at = "2026-08-24T03:00:00.000Z";
    try {
      await migrate(drizzle(client), {
        migrationsFolder: through0017,
        migrationsSchema: journalSchema,
      });
      await client.unsafe(`
        insert into identity_users
          (id, name, email, canonical_email, email_verified, email_verified_at,
           email_verification_provenance, access_status, authorization_version,
           created_at, updated_at)
        values ('${userId}', 'Legacy User', '${userId}@example.com', '${userId}@example.com',
          true, '${at}', 'password_email_challenge', 'active', 1, '${at}', '${at}');
        insert into creator_applications
          (id, user_id, state, version, current_revision_id, created_at, updated_at)
        values ('${applicationId}', '${userId}', 'submitted', 1, '${revisionId}', '${at}', '${at}');
        insert into creator_application_revisions
          (id, application_id, revision_number, artist_display_name, short_introduction,
           applicant_email, dob_envelope, portfolio_urls, primary_art_discipline,
           practice_description, content_intent, proposed_receiving_account_id,
           age_at_submission, age_evaluated_on, submitted_at, created_at, updated_at)
        values ('${revisionId}', '${applicationId}', 1, 'Legacy Artist', 'Introduction',
          '${userId}@example.com', '{"version":1}'::jsonb,
          '["https://example.com/legacy"]'::jsonb, 'illustration', 'Practice',
          'general_audience_only', 'legacy-account', 21, '2026-08-24',
          '${at}', '${at}', '${at}')
      `);

      await expect(
        migrate(drizzle(client), { migrationsFolder, migrationsSchema: journalSchema }),
      ).resolves.toBeUndefined();
      await expect(
        client<{ id: string }[]>`select id from creator_application_revisions where id = ${revisionId}`,
      ).resolves.toEqual([{ id: revisionId }]);
      await expect(
        client.unsafe(`
          insert into creator_application_revisions
            (id, application_id, revision_number, artist_display_name,
             submitted_at, created_at, updated_at)
          values ('${randomUUID()}', '${applicationId}', 2, 'Partial', '${at}', '${at}', '${at}')
        `),
      ).rejects.toThrow();
    } finally {
      await client.end();
      await rm(through0017, { recursive: true, force: true });
    }
  });

  test("upgrades compatible 0018 hold rows with stable identities and lifecycle guards", async () => {
    // Break caught: adding the hold primary key or compatibility constraint in
    // a way that only works for blank databases.
    const { client, journalSchema } = await createIsolatedClient("task9-hold-upgrade");
    const through0018 = await createMigrationsThrough(18);
    try {
      await migrate(drizzle(client), {
        migrationsFolder: through0018,
        migrationsSchema: journalSchema,
      });
      await client.unsafe(`
        insert into system_retention_holds
          (dataset, subject_type, subject_id, reason_category, reference_id,
           starts_at, created_at)
        values ('sessions', 'user', 'task9-upgrade-held-user', 'incident',
          'task9-upgrade-hold-reference', '2026-08-24T03:00:00Z',
          '2026-08-24T03:00:00Z')
      `);

      await expect(
        migrate(drizzle(client), { migrationsFolder, migrationsSchema: journalSchema }),
      ).resolves.toBeUndefined();
      const [hold] = await client<{ id: string }[]>`
        select id from system_retention_holds
        where reference_id = 'task9-upgrade-hold-reference'
      `;
      expect(hold?.id).toMatch(/^[0-9a-f-]{36}$/);
      await expect(client.unsafe(`
        update system_retention_holds
        set released_at = '2026-08-25T03:00:00Z'
        where id = '${hold?.id}'
      `)).resolves.toBeDefined();
      await expect(client.unsafe(`
        delete from system_retention_holds where id = '${hold?.id}'
      `)).rejects.toThrow("retention hold records are append-only");
    } finally {
      await client.end();
      await rm(through0018, { recursive: true, force: true });
    }
  });
});
