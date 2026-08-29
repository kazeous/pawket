import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  creatorDiscoveryProjections,
  creatorHandleClaims,
  creatorPageDrafts,
  creatorPages,
  creatorPublicationEvents,
  creatorPublicationMedia,
  creatorPublicationRevisions,
  creatorPublicationShowcases,
  creatorShowcaseDraftMedia,
  creatorShowcaseDrafts,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database integration tests");

const schemaName = `creator_catalog_schema_${process.pid}_${Date.now()}`;
const client = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
const migrationsDirectory = new URL("../migrations/", import.meta.url);
const at = "2026-08-29T00:00:00.000Z";

async function executeMigration(filename: string): Promise<void> {
  const migration = await readFile(new URL(filename, migrationsDirectory), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.unsafe(statement);
  }
}

async function createUser(): Promise<string> {
  const userId = `creator-catalog-user-${randomUUID()}`;
  await client.unsafe(`
    insert into identity_users
      (id, name, email, canonical_email, email_verified, access_status, authorization_version,
       created_at, updated_at)
    values ('${userId}', 'Catalog Artist', '${userId}@example.com', '${userId}@example.com',
      false, 'active', 1, '${at}', '${at}')
  `);
  return userId;
}

async function createPage(userId: string): Promise<string> {
  const pageId = randomUUID();
  await client.unsafe(`
    insert into creator_pages
      (id, user_id, draft_version, initialized_from_revision_id, created_at, updated_at)
    values ('${pageId}', '${userId}', 1, '${randomUUID()}', '${at}', '${at}')
  `);
  return pageId;
}

async function createRevision(pageId: string, userId: string, revisionNumber = 1): Promise<string> {
  const revisionId = randomUUID();
  await client.unsafe(`
    insert into creator_publication_revisions
      (id, page_id, revision_number, canonical_handle, display_name, short_introduction,
       primary_discipline, secondary_disciplines, taxonomy_version, policy_version,
       actor_user_id, actor_session_id, expected_draft_version, request_id, published_at)
    values ('${revisionId}', '${pageId}', ${revisionNumber}, 'artist-${revisionNumber}', 'Artist', 'Introduction',
      'illustration', ARRAY['drawing']::text[], 'creator-discipline-v1', 'general-audience-v1',
      '${userId}', 'session-1', 1, 'request-${revisionNumber}-${randomUUID()}', '${at}')
  `);
  return revisionId;
}

async function expectAppendOnly(query: string): Promise<void> {
  await expect(client.unsafe(query)).rejects.toThrow(/append-only/);
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

describe("creator catalog persistence schema", () => {
  test("uses targeted asset indexes for profile and showcase publication lookups", async () => {
    // Break caught: public derivative authorization regresses to scanning every publication row for random assets.
    const indexes = await client<{ indexname: string }[]>`
      select indexname from pg_indexes
      where schemaname = ${schemaName} and indexname in (
        'creator_publication_media_asset_showcase_idx',
        'creator_publication_revisions_avatar_asset_idx',
        'creator_publication_revisions_cover_asset_idx'
      ) order by indexname
    `;
    expect(indexes.map((row) => row.indexname)).toEqual([
      "creator_publication_media_asset_showcase_idx",
      "creator_publication_revisions_avatar_asset_idx",
      "creator_publication_revisions_cover_asset_idx",
    ]);
    await client.unsafe("set enable_seqscan = off");
    try {
      const assetId = randomUUID();
      const userId = await createUser();
      const pageId = await createPage(userId);
      const revisionId = randomUUID();
      const showcaseId = randomUUID();
      await client.unsafe(`insert into creator_publication_revisions
        (id,page_id,revision_number,canonical_handle,display_name,short_introduction,primary_discipline,secondary_disciplines,avatar_asset_id,avatar_thumb_derivative_id,avatar_display_derivative_id,cover_asset_id,cover_display_derivative_id,taxonomy_version,policy_version,actor_user_id,actor_session_id,expected_draft_version,request_id,published_at)
        values ('${revisionId}','${pageId}',1,'indexed-artist','Indexed','Indexed introduction','illustration',ARRAY[]::text[],'${assetId}','${randomUUID()}','${randomUUID()}','${assetId}','${randomUUID()}','creator-discipline-v1','general-audience-v1','${userId}','session-index',1,'request-index','${at}')`);
      await client.unsafe(`insert into creator_publication_showcases (id,revision_id,source_showcase_id,position,title,description,discipline,content_label) values ('${showcaseId}','${revisionId}','${randomUUID()}',0,'Indexed showcase','','illustration','general_audience')`);
      await client.unsafe(`insert into creator_publication_media (id,publication_showcase_id,asset_id,position,alternative_text,thumb_derivative_id,display_derivative_id,large_derivative_id) values ('${randomUUID()}','${showcaseId}','${assetId}',0,'Indexed asset','${randomUUID()}','${randomUUID()}','${randomUUID()}')`);
      const mediaPlan = await client.unsafe(`explain (costs off) select publication_showcase_id from creator_publication_media where asset_id = '${assetId}'`);
      const avatarPlan = await client.unsafe(`explain (costs off) select page_id from creator_publication_revisions where avatar_asset_id = '${assetId}'`);
      const coverPlan = await client.unsafe(`explain (costs off) select page_id from creator_publication_revisions where cover_asset_id = '${assetId}'`);
      expect(JSON.stringify(mediaPlan)).toContain("creator_publication_media_asset_showcase_idx");
      expect(JSON.stringify(avatarPlan)).toContain("creator_publication_revisions_avatar_asset_idx");
      expect(JSON.stringify(coverPlan)).toContain("creator_publication_revisions_cover_asset_idx");
      const unknownPlan = await client.unsafe(`explain (costs off) select publication_showcase_id from creator_publication_media where asset_id = '${randomUUID()}'`);
      expect(JSON.stringify(unknownPlan)).toContain("creator_publication_media_asset_showcase_idx");
    } finally {
      await client.unsafe("reset enable_seqscan");
    }
  });

  test("exports the complete authoritative catalog table boundary", () => {
    // Break caught: a migration or schema file exists but consumers cannot use the tables.
    expect({
      creatorPages,
      creatorHandleClaims,
      creatorPageDrafts,
      creatorShowcaseDrafts,
      creatorShowcaseDraftMedia,
      creatorPublicationRevisions,
      creatorPublicationShowcases,
      creatorPublicationMedia,
      creatorPublicationEvents,
      creatorDiscoveryProjections,
    }).toEqual({
      creatorPages: expect.anything(),
      creatorHandleClaims: expect.anything(),
      creatorPageDrafts: expect.anything(),
      creatorShowcaseDrafts: expect.anything(),
      creatorShowcaseDraftMedia: expect.anything(),
      creatorPublicationRevisions: expect.anything(),
      creatorPublicationShowcases: expect.anything(),
      creatorPublicationMedia: expect.anything(),
      creatorPublicationEvents: expect.anything(),
      creatorDiscoveryProjections: expect.anything(),
    });
  });

  test("rejects draft version zero for an existing valid user", async () => {
    // Break caught: changing the page check to allow an invalid optimistic version.
    const userId = await createUser();
    await expect(client.unsafe(`
      insert into creator_pages
        (id, user_id, draft_version, initialized_from_revision_id, created_at, updated_at)
      values ('${randomUUID()}', '${userId}', 0, '${randomUUID()}', '${at}', '${at}')
    `)).rejects.toThrow();
  });

  test("rejects invalid handle boundaries and globally colliding claims", async () => {
    // Break caught: handle syntax or case-insensitive global identity becoming permissive.
    const firstUserId = await createUser();
    const secondUserId = await createUser();
    const firstPageId = await createPage(firstUserId);
    const secondPageId = await createPage(secondUserId);
    for (const handle of ["a", "ab", "a".repeat(31), "-artist", "artist-", "artist--one", "Artist"]) {
      await expect(client.unsafe(`
        insert into creator_handle_claims (id, page_id, normalized_handle, kind, claimed_at)
        values ('${randomUUID()}', '${firstPageId}', '${handle}', 'canonical', '${at}')
      `)).rejects.toThrow();
    }
    await client.unsafe(`
      insert into creator_handle_claims (id, page_id, normalized_handle, kind, claimed_at)
      values ('${randomUUID()}', '${firstPageId}', 'artist-one', 'canonical', '${at}')
    `);
    await expect(client.unsafe(`
      insert into creator_handle_claims (id, page_id, normalized_handle, kind, claimed_at)
      values ('${randomUUID()}', '${secondPageId}', 'artist-one', 'canonical', '${at}')
    `)).rejects.toThrow();
  });

  test("rejects direct aliases and permits only an atomic canonical replacement", async () => {
    // Break caught: an alias can be inserted or mutated outside a successful rename transaction.
    const userId = await createUser();
    const pageId = await createPage(userId);
    const canonicalId = randomUUID();
    await expect(client.unsafe(`
      insert into creator_handle_claims (id, page_id, normalized_handle, kind, claimed_at, replaced_at)
      values ('${randomUUID()}', '${pageId}', 'artist-alias', 'alias', '${at}', '${at}')
    `)).rejects.toThrow(/canonical/);
    await client.unsafe(`
      insert into creator_handle_claims (id, page_id, normalized_handle, kind, claimed_at)
      values ('${canonicalId}', '${pageId}', 'artist-old', 'canonical', '${at}')
    `);
    await expect(client.unsafe(`
      update creator_handle_claims set kind = 'alias', replaced_at = '${at}' where id = '${canonicalId}'
    `)).rejects.toThrow(/append-only/);
    await client.unsafe("begin");
    try {
      await client.unsafe(`
        update creator_handle_claims set kind = 'alias', replaced_at = '${at}' where id = '${canonicalId}'
      `);
      await client.unsafe(`
        insert into creator_handle_claims (id, page_id, normalized_handle, kind, claimed_at)
        values ('${randomUUID()}', '${pageId}', 'artist-new', 'canonical', '${at}')
      `);
      await client.unsafe("commit");
    } catch (error) {
      await client.unsafe("rollback");
      throw error;
    }
    await expectAppendOnly(`delete from creator_handle_claims where id = '${canonicalId}'`);
  });

  test("applies the canonical-handle contract to revision snapshots and discovery projections", async () => {
    // Break caught: a public snapshot/projection bypasses the permanent-handle syntax contract.
    const userId = await createUser();
    const pageId = await createPage(userId);
    await expect(client.unsafe(`
      insert into creator_publication_revisions
        (id, page_id, revision_number, canonical_handle, display_name, short_introduction,
         primary_discipline, secondary_disciplines, taxonomy_version, policy_version,
         actor_user_id, actor_session_id, expected_draft_version, request_id, published_at)
      values ('${randomUUID()}', '${pageId}', 1, 'artist--invalid', 'Artist', 'Introduction',
        'illustration', ARRAY[]::text[], 'creator-discipline-v1', 'general-audience-v1', '${userId}', 'session', 1, 'request-handle', '${at}')
    `)).rejects.toThrow();
    const revisionId = await createRevision(pageId, userId);
    await expect(client.unsafe(`
      insert into creator_discovery_projections
        (page_id, revision_id, canonical_handle, display_name, short_introduction, disciplines, revision_at, enabled)
      values ('${pageId}', '${revisionId}', 'artist-', 'Artist', 'Introduction', ARRAY['illustration']::text[], '${at}', true)
    `)).rejects.toThrow();
    const columns = await client<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = ${schemaName} and table_name = 'creator_discovery_projections'
      order by ordinal_position
    `;
    expect(columns.map((column) => column.column_name)).toEqual([
      "page_id", "revision_id", "canonical_handle", "display_name", "short_introduction",
      "disciplines", "avatar_thumb_derivative_id", "revision_at", "enabled",
    ]);
    const secondUserId = await createUser();
    const secondPageId = await createPage(secondUserId);
    const secondRevisionId = await createRevision(secondPageId, secondUserId);
    await client.unsafe("begin");
    try {
      await client.unsafe("alter table creator_discovery_projections drop constraint creator_discovery_projections_canonical_handle_check");
      await client.unsafe(`
        insert into creator_discovery_projections
          (page_id, revision_id, canonical_handle, display_name, short_introduction, disciplines, revision_at, enabled)
        values ('${pageId}', '${revisionId}', 'artist-projection', 'Artist', 'Introduction', ARRAY['illustration']::text[], '${at}', true)
      `);
      await expect(client.unsafe(`
        insert into creator_discovery_projections
          (page_id, revision_id, canonical_handle, display_name, short_introduction, disciplines, revision_at, enabled)
        values ('${secondPageId}', '${secondRevisionId}', 'ARTIST-PROJECTION', 'Artist', 'Introduction', ARRAY['illustration']::text[], '${at}', true)
      `)).rejects.toThrow();
    } finally {
      await client.unsafe("rollback");
    }
  });

  test("rejects duplicate active draft positions and isolates the 13th showcase guard", async () => {
    // Break caught: active showcase ordering ceases to be unique or the count trigger is removed.
    const userId = await createUser();
    const pageId = await createPage(userId);
    const insertShowcase = (position: number) => client.unsafe(`
      insert into creator_showcase_drafts
        (id, page_id, position, title, description, discipline, content_label, created_at, updated_at)
      values ('${randomUUID()}', '${pageId}', ${position}, 'Showcase ${position}', '', 'illustration',
        'general_audience', '${at}', '${at}')
    `);
    await insertShowcase(0);
    await expect(insertShowcase(0)).rejects.toThrow();
    await client.unsafe("begin");
    try {
      await client.unsafe("alter table creator_showcase_drafts drop constraint creator_showcase_drafts_position_check");
      for (let position = 1; position <= 11; position += 1) await insertShowcase(position);
      await expect(insertShowcase(12)).rejects.toThrow(/at most 12 active showcases/);
    } finally {
      await client.unsafe("rollback");
    }
  });

  test("rejects duplicate media positions and isolates the fifth-media guard", async () => {
    // Break caught: showcase media ordering ceases to be unique or the count trigger is removed.
    const userId = await createUser();
    const pageId = await createPage(userId);
    const showcaseId = randomUUID();
    await client.unsafe(`
      insert into creator_showcase_drafts
        (id, page_id, position, title, description, discipline, content_label, created_at, updated_at)
      values ('${showcaseId}', '${pageId}', 0, 'Showcase', '', 'illustration', 'general_audience', '${at}', '${at}')
    `);
    const insertMedia = (position: number) => client.unsafe(`
      insert into creator_showcase_draft_media
        (id, showcase_id, asset_id, position, alternative_text, created_at, updated_at)
      values ('${randomUUID()}', '${showcaseId}', '${randomUUID()}', ${position}, 'Alternative ${position}', '${at}', '${at}')
    `);
    await insertMedia(0);
    await expect(insertMedia(0)).rejects.toThrow();
    await client.unsafe("begin");
    try {
      await client.unsafe("alter table creator_showcase_draft_media drop constraint creator_showcase_draft_media_position_check");
      for (let position = 1; position <= 3; position += 1) await insertMedia(position);
      await expect(insertMedia(4)).rejects.toThrow(/at most four media rows/);
    } finally {
      await client.unsafe("rollback");
    }
  });

  test("enforces immutable revision taxonomy, policy, and child positions", async () => {
    // Break caught: revisions accept an unsupported public policy or duplicate ordered children.
    const userId = await createUser();
    const pageId = await createPage(userId);
    await expect(client.unsafe(`
      insert into creator_publication_revisions
        (id, page_id, revision_number, canonical_handle, display_name, short_introduction,
         primary_discipline, secondary_disciplines, taxonomy_version, policy_version,
         actor_user_id, actor_session_id, expected_draft_version, request_id, published_at)
      values ('${randomUUID()}', '${pageId}', 1, 'artist-invalid', 'Artist', 'Introduction',
        'unsupported', ARRAY[]::text[], 'creator-discipline-v1', 'general-audience-v1', '${userId}', 'session', 1, 'request-a', '${at}')
    `)).rejects.toThrow();
    await expect(client.unsafe(`
      insert into creator_publication_revisions
        (id, page_id, revision_number, canonical_handle, display_name, short_introduction,
         primary_discipline, secondary_disciplines, taxonomy_version, policy_version,
         actor_user_id, actor_session_id, expected_draft_version, request_id, published_at)
      values ('${randomUUID()}', '${pageId}', 1, 'artist-invalid', 'Artist', 'Introduction',
        'illustration', ARRAY[]::text[], 'v2', 'age_restricted.v1', '${userId}', 'session', 1, 'request-b', '${at}')
    `)).rejects.toThrow();
    const revisionId = await createRevision(pageId, userId);
    await expect(createRevision(pageId, userId)).rejects.toThrow();
    const showcaseId = randomUUID();
    await client.unsafe(`
      insert into creator_publication_showcases
        (id, revision_id, source_showcase_id, position, title, description, discipline, content_label)
      values ('${showcaseId}', '${revisionId}', '${randomUUID()}', 0, 'Published', '', 'illustration', 'general_audience')
    `);
    await expect(client.unsafe(`
      insert into creator_publication_showcases
        (id, revision_id, source_showcase_id, position, title, description, discipline, content_label)
      values ('${randomUUID()}', '${revisionId}', '${randomUUID()}', 0, 'Duplicate', '', 'illustration', 'general_audience')
    `)).rejects.toThrow();
    await client.unsafe(`
      insert into creator_publication_media
        (id, publication_showcase_id, asset_id, position, alternative_text, thumb_derivative_id, display_derivative_id, large_derivative_id)
      values ('${randomUUID()}', '${showcaseId}', '${randomUUID()}', 0, 'Alternative', '${randomUUID()}', '${randomUUID()}', '${randomUUID()}')
    `);
    await expect(client.unsafe(`
      insert into creator_publication_media
        (id, publication_showcase_id, asset_id, position, alternative_text, thumb_derivative_id, display_derivative_id, large_derivative_id)
      values ('${randomUUID()}', '${showcaseId}', '${randomUUID()}', 0, 'Duplicate', '${randomUUID()}', '${randomUUID()}', '${randomUUID()}')
    `)).rejects.toThrow();
  });

  test("rejects cross-page revision references in heads, events, and discovery projections", async () => {
    // Break caught: a page can claim another page's immutable revision as its own public state.
    const firstUserId = await createUser();
    const secondUserId = await createUser();
    const firstPageId = await createPage(firstUserId);
    const secondPageId = await createPage(secondUserId);
    const firstRevisionId = await createRevision(firstPageId, firstUserId);
    await expect(client.unsafe(`
      update creator_pages set published_revision_id = '${firstRevisionId}' where id = '${secondPageId}'
    `)).rejects.toThrow();
    await expect(client.unsafe(`
      insert into creator_publication_events
        (id, page_id, revision_id, type, actor_user_id, actor_session_id, expected_draft_version, request_id, occurred_at)
      values ('${randomUUID()}', '${secondPageId}', '${firstRevisionId}', 'published', '${secondUserId}', 'session', 1, 'event-a', '${at}')
    `)).rejects.toThrow();
    await expect(client.unsafe(`
      insert into creator_discovery_projections
        (page_id, revision_id, canonical_handle, display_name, short_introduction, disciplines, revision_at, enabled)
      values ('${secondPageId}', '${firstRevisionId}', 'artist-projection', 'Artist', 'Introduction', ARRAY['illustration']::text[], '${at}', true)
    `)).rejects.toThrow();
  });

  test("rejects update and delete of publication rows and events", async () => {
    // Break caught: immutable public history can be changed or removed after publication.
    const userId = await createUser();
    const pageId = await createPage(userId);
    const revisionId = await createRevision(pageId, userId);
    const showcaseId = randomUUID();
    const mediaId = randomUUID();
    const eventId = randomUUID();
    await client.unsafe(`
      insert into creator_publication_showcases
        (id, revision_id, source_showcase_id, position, title, description, discipline, content_label)
      values ('${showcaseId}', '${revisionId}', '${randomUUID()}', 0, 'Published', '', 'illustration', 'general_audience')
    `);
    await client.unsafe(`
      insert into creator_publication_media
        (id, publication_showcase_id, asset_id, position, alternative_text, thumb_derivative_id, display_derivative_id, large_derivative_id)
      values ('${mediaId}', '${showcaseId}', '${randomUUID()}', 0, 'Alternative', '${randomUUID()}', '${randomUUID()}', '${randomUUID()}')
    `);
    await client.unsafe(`
      insert into creator_publication_events
        (id, page_id, revision_id, type, actor_user_id, actor_session_id, expected_draft_version, request_id, occurred_at)
      values ('${eventId}', '${pageId}', '${revisionId}', 'published', '${userId}', 'session', 1, 'event-b', '${at}')
    `);
    await expectAppendOnly(`update creator_publication_revisions set display_name = 'Changed' where id = '${revisionId}'`);
    await expectAppendOnly(`delete from creator_publication_showcases where id = '${showcaseId}'`);
    await expectAppendOnly(`update creator_publication_media set alternative_text = 'Changed' where id = '${mediaId}'`);
    await expectAppendOnly(`delete from creator_publication_events where id = '${eventId}'`);
  });
});
