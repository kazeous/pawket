import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import * as database from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for cross-domain integration tests");

const schemaName = `increment_three_cross_domain_${process.pid}_${Date.now()}`;
const journalSchema = `${schemaName}_drizzle`;
const migrationsFolder = fileURLToPath(new URL("../migrations/", import.meta.url));
const admin = postgres(databaseUrl, { max: 1 });
const client = postgres(databaseUrl, { max: 3 });
const at = new Date("2026-08-31T05:00:00.000Z");
const ownerUserId = "cross-domain-owner";
const creatorUserId = "cross-domain-creator";
const pageId = "23000000-0000-4000-8000-000000000001";
const firstRevisionId = "23000000-0000-4000-8000-000000000002";
const firstShowcaseRowId = "23000000-0000-4000-8000-000000000003";
const firstShowcaseId = "23000000-0000-4000-8000-000000000004";
const protectedAssetId = "23000000-0000-4000-8000-000000000005";
const secondRevisionId = "23000000-0000-4000-8000-000000000006";
const secondShowcaseRowId = "23000000-0000-4000-8000-000000000007";
const secondShowcaseId = "23000000-0000-4000-8000-000000000008";
const unprotectedAssetId = "23000000-0000-4000-8000-000000000009";
const creatorApplicationId = "23000000-0000-4000-8000-000000000010";

async function seedPublicationEvidence(): Promise<void> {
  const timestamp = at.toISOString();
  await client`
    insert into identity_users
      (id, name, email, canonical_email, email_verified, email_verified_at,
       email_verification_provenance, access_status, authorization_version, created_at, updated_at)
    values
      (${ownerUserId}, 'Owner', 'cross-owner@pawket.test', 'cross-owner@pawket.test', true,
       ${timestamp}, 'password_email_challenge', 'active', 1, ${timestamp}, ${timestamp}),
      (${creatorUserId}, 'Creator', 'cross-creator@pawket.test', 'cross-creator@pawket.test', true,
       ${timestamp}, 'password_email_challenge', 'active', 1, ${timestamp}, ${timestamp})`;
  await client`
    insert into creator_applications
      (id, user_id, state, version, current_revision_id, created_at, updated_at)
    values (${creatorApplicationId}, ${creatorUserId}, 'draft', 1, null, ${timestamp}, ${timestamp})`;
  await client`
    insert into creator_pages
      (id, user_id, draft_version, initialized_from_revision_id, created_at, updated_at)
    values (${pageId}, ${creatorUserId}, 1, ${randomUUID()}, ${timestamp}, ${timestamp})`;
  for (const revision of [
    { id: firstRevisionId, handle: "held-revision", number: 1 },
    { id: secondRevisionId, handle: "later-revision", number: 2 },
  ]) {
    await client`
      insert into creator_publication_revisions
        (id, page_id, revision_number, canonical_handle, display_name, short_introduction,
         primary_discipline, secondary_disciplines, taxonomy_version, policy_version,
         actor_user_id, actor_session_id, expected_draft_version, request_id, published_at)
      values (${revision.id}, ${pageId}, ${revision.number}, ${revision.handle}, 'Cross-domain Creator',
        'Cross-domain introduction.', 'illustration', array[]::text[], 'creator-discipline-v1',
        'general-audience-v1', ${creatorUserId}, 'creator-session', 1,
        ${`seed-${revision.handle}`}, ${timestamp})`;
  }
  await client`
    insert into creator_publication_showcases
      (id, revision_id, source_showcase_id, position, title, description, discipline, content_label)
    values
      (${firstShowcaseRowId}, ${firstRevisionId}, ${firstShowcaseId}, 0, 'Held work', '', 'illustration', 'general_audience'),
      (${secondShowcaseRowId}, ${secondRevisionId}, ${secondShowcaseId}, 0, 'Later work', '', 'illustration', 'general_audience')`;
  for (const assetId of [protectedAssetId, unprotectedAssetId]) {
    await client`
      insert into public_media_assets
        (id, owner_user_id, purpose, declared_source_format, state, source_allocation_bytes,
         source_object_key, created_at, updated_at)
      values (${assetId}, ${creatorUserId}, 'showcase', 'jpeg', 'awaiting_upload', 100,
        ${`quarantine/${assetId}/${randomUUID()}`}, ${timestamp}, ${timestamp})`;
    await client`
      update public_media_assets
      set state = 'failed', failure_code = 'processing_error',
          updated_at = ${new Date(at.getTime() + 100).toISOString()}
      where id = ${assetId}`;
  }
  await client`
    insert into creator_publication_media
      (id, publication_showcase_id, asset_id, position, alternative_text,
       thumb_derivative_id, display_derivative_id, large_derivative_id)
    values
      (${randomUUID()}, ${firstShowcaseRowId}, ${protectedAssetId}, 0, 'Held artwork', ${randomUUID()}, ${randomUUID()}, ${randomUUID()}),
      (${randomUUID()}, ${secondShowcaseRowId}, ${unprotectedAssetId}, 0, 'Later artwork', ${randomUUID()}, ${randomUUID()}, ${randomUUID()})`;
}

async function insertOpenPageReport(): Promise<void> {
  await client`
    insert into public_content_reports
      (id, report_reference, target_type, target_id, publication_revision_id,
       reason, detail, reporter_user_id, state, version, created_at, updated_at)
    values (${randomUUID()}, ${`report:v1:${randomUUID().replaceAll("-", "")}`}, 'page', ${pageId},
      ${firstRevisionId}, 'privacy', null, null, 'open', 1, ${at.toISOString()}, ${at.toISOString()})`;
}

beforeAll(async () => {
  await admin.unsafe(`create schema "${schemaName}"`);
  await client.unsafe(`set search_path to "${schemaName}", public`);
  await migrate(drizzle(client), { migrationsFolder, migrationsSchema: journalSchema });
});

beforeEach(async () => {
  await client.unsafe(`truncate table system_retention_holds cascade`);
  await client.unsafe(`truncate table identity_users cascade`);
  await seedPublicationEvidence();
});

afterAll(async () => {
  await client.end();
  await admin.unsafe(`drop schema if exists "${schemaName}" cascade`);
  await admin.end();
});

describe("Increment 3 final cross-domain guards", () => {
  test("exports the four media cleanup datasets as report-only policies", () => {
    // Break caught: a cleanup dataset is omitted, gets the wrong age, or becomes enforce-by-default.
    const api = database as unknown as { INCREMENT_THREE_RETENTION_DATASETS?: readonly unknown[] };
    expect(api.INCREMENT_THREE_RETENTION_DATASETS).toEqual([
      { name: "public_media_processed_source", defaultMode: "report_only", ageHours: 24 },
      { name: "public_media_failed_quarantine", defaultMode: "report_only", ageHours: 168 },
      { name: "public_media_ready_unreferenced", defaultMode: "report_only", ageHours: 720 },
      { name: "public_media_superseded_derivative", defaultMode: "report_only", ageHours: 4_320 },
    ]);
  });

  test("publication child rows remain immutable at final migration head", async () => {
    // Break caught: migration 0023 replaces or drops an existing publication-child append-only guard.
    await expect(client`update creator_publication_showcases set title = 'Rewritten' where id = ${firstShowcaseRowId}`).rejects.toThrow(/append-only/i);
    await expect(client`delete from creator_publication_media where asset_id = ${protectedAssetId}`).rejects.toThrow(/append-only/i);
  });

  test("media processing attempts may only close once without changing ownership facts", async () => {
    // Break caught: an open processing attempt can be reassigned to another worker before terminal closure.
    const attemptId = randomUUID();
    await client`
      insert into public_media_processing_attempts
        (id, asset_id, attempt_number, worker_id, outcome_code, started_at, finished_at,
         next_retry_at, created_at, updated_at)
      values (${attemptId}, ${protectedAssetId}, 1, 'worker-one', 'started', ${at.toISOString()},
        null, null, ${at.toISOString()}, ${at.toISOString()})`;
    await expect(client`
      update public_media_processing_attempts
      set updated_at = ${new Date(at.getTime() + 500).toISOString()}
      where id = ${attemptId}`).rejects.toThrow(/only close/i);
    await expect(client`
      update public_media_processing_attempts
      set worker_id = 'worker-two', outcome_code = 'failed', finished_at = ${new Date(at.getTime() + 1_000).toISOString()},
          updated_at = ${new Date(at.getTime() + 1_000).toISOString()}
      where id = ${attemptId}`).rejects.toThrow(/identity|worker|immutable/i);
    await expect(client`
      update public_media_processing_attempts
      set outcome_code = 'failed', finished_at = ${new Date(at.getTime() + 1_000).toISOString()},
          updated_at = ${new Date(at.getTime() + 1_000).toISOString()}
      where id = ${attemptId}`).resolves.toBeDefined();
    await expect(client`update public_media_processing_attempts set updated_at = ${new Date(at.getTime() + 2_000).toISOString()} where id = ${attemptId}`).rejects.toThrow(/terminal|immutable/i);
  });

  test("an open exact-revision report blocks only matching asset source cleanup", async () => {
    // Break caught: cleanup ignores an open report or protects unrelated later-revision media instead of exact evidence.
    await insertOpenPageReport();
    await expect(client`update public_media_assets set source_deleted_at = ${new Date(at.getTime() + 1_000).toISOString()}, updated_at = ${new Date(at.getTime() + 1_000).toISOString()} where id = ${protectedAssetId}`).rejects.toThrow(/hold|report|cleanup/i);
    await expect(client`update public_media_assets set source_deleted_at = ${new Date(at.getTime() + 1_000).toISOString()}, updated_at = ${new Date(at.getTime() + 1_000).toISOString()} where id = ${unprotectedAssetId}`).resolves.toBeDefined();
  });

  test.each(["incident", "legal"] as const)("an active owner %s hold blocks media source cleanup", async (reasonCategory) => {
    // Break caught: database defense-in-depth ignores an active user-level incident or legal hold.
    await client`
      insert into system_retention_holds
        (dataset, subject_type, subject_id, reason_category, reference_id, starts_at, created_at)
      values ('sessions', 'user', ${creatorUserId}, ${reasonCategory}, ${`${reasonCategory}-task13-media`},
        ${at.toISOString()}, ${at.toISOString()})`;
    await expect(client`update public_media_assets set source_deleted_at = ${new Date(at.getTime() + 1_000).toISOString()}, updated_at = ${new Date(at.getTime() + 1_000).toISOString()} where id = ${protectedAssetId}`).rejects.toThrow(/hold|cleanup/i);
  });

  test("an active creator-application hold blocks its creator's media source cleanup", async () => {
    // Break caught: the database guard applies incident/legal holds to direct user rows but ignores the creator application that owns the media creator.
    await client`
      insert into system_retention_holds
        (dataset, subject_type, subject_id, reason_category, reference_id, starts_at, created_at)
      values ('application_content', 'creator_application', ${creatorApplicationId}, 'legal',
        'legal-task13-creator-application-media', ${at.toISOString()}, ${at.toISOString()})`;
    await expect(client`
      update public_media_assets
      set source_deleted_at = ${new Date(at.getTime() + 1_000).toISOString()},
          updated_at = ${new Date(at.getTime() + 1_000).toISOString()}
      where id = ${protectedAssetId}`).rejects.toThrow(/hold|cleanup/i);
  });

  test("final trigger set is present without duplicate publication or attempt guards", async () => {
    // Break caught: forward migration duplicates existing triggers or omits the new cleanup guard.
    const triggers = await client<{ tgname: string; count: number }[]>`
      select tgname, count(*)::int as count from pg_trigger
      where not tgisinternal and tgrelid in (
        'creator_publication_showcases'::regclass,
        'creator_publication_media'::regclass,
        'public_media_processing_attempts'::regclass,
        'public_media_assets'::regclass
      ) and tgname in (
        'creator_publication_showcases_append_only',
        'creator_publication_media_append_only',
        'public_media_attempts_one_way_close',
        'public_media_cleanup_hold_guard'
      ) group by tgname order by tgname`;
    expect(triggers).toEqual([
      { tgname: "creator_publication_media_append_only", count: 1 },
      { tgname: "creator_publication_showcases_append_only", count: 1 },
      { tgname: "public_media_attempts_one_way_close", count: 1 },
      { tgname: "public_media_cleanup_hold_guard", count: 1 },
    ]);
  });
});
