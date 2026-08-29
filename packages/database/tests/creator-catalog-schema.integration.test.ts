import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
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
const db = drizzle(client);
const migrationsDirectory = new URL("../migrations/", import.meta.url);

async function executeMigration(filename: string): Promise<void> {
  const migration = await readFile(new URL(filename, migrationsDirectory), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.unsafe(statement);
  }
}

async function insertUser(userId: string, at: Date): Promise<void> {
  await client.unsafe(`
    insert into identity_users
      (id, name, email, canonical_email, email_verified, access_status, authorization_version,
       created_at, updated_at)
    values ('${userId}', 'Catalog Artist', '${userId}@example.com', '${userId}@example.com',
      false, 'active', 1, '${at.toISOString()}', '${at.toISOString()}')
  `);
}

async function expectAppendOnly(action: Promise<unknown>): Promise<void> {
  await expect(action).rejects.toMatchObject({
    cause: { message: expect.stringMatching(/append-only/) },
  });
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
  test("enforces one page, one canonical handle, permanent aliases, and immutable publication rows", async () => {
    // Break caught: a catalog migration without the database invariants that prevent
    // concurrent handle/page changes from corrupting public identity or history.
    const userId = `creator-catalog-user-${randomUUID()}`;
    const pageId = randomUUID();
    const canonicalClaimId = randomUUID();
    const at = new Date("2026-08-29T00:00:00.000Z");
    await insertUser(userId, at);

    await db.insert(creatorPages).values({
      id: pageId,
      userId,
      draftVersion: 1,
      initializedFromRevisionId: randomUUID(),
      createdAt: at,
      updatedAt: at,
    });
    await expect(db.insert(creatorPages).values({
      id: randomUUID(),
      userId,
      draftVersion: 1,
      initializedFromRevisionId: randomUUID(),
      createdAt: at,
      updatedAt: at,
    })).rejects.toThrow();
    await expect(db.insert(creatorPages).values({
      id: randomUUID(),
      userId: `missing-${randomUUID()}`,
      draftVersion: 0,
      initializedFromRevisionId: randomUUID(),
      createdAt: at,
      updatedAt: at,
    })).rejects.toThrow();

    await db.insert(creatorHandleClaims).values({
      id: canonicalClaimId, pageId, normalizedHandle: "artist-one", kind: "canonical", claimedAt: at,
    });
    await expect(db.insert(creatorHandleClaims).values({
      id: randomUUID(), pageId, normalizedHandle: "artist-two", kind: "canonical", claimedAt: at,
    })).rejects.toThrow();
    await expectAppendOnly(db.delete(creatorHandleClaims).where(eq(creatorHandleClaims.pageId, pageId)));
    await db.transaction(async (tx) => {
      await tx.update(creatorHandleClaims).set({ kind: "alias", replacedAt: at })
        .where(eq(creatorHandleClaims.id, canonicalClaimId));
      await tx.insert(creatorHandleClaims).values({
        id: randomUUID(), pageId, normalizedHandle: "artist-two", kind: "canonical", claimedAt: at,
      });
    });
    await expectAppendOnly(db.update(creatorHandleClaims).set({ normalizedHandle: "artist-three" })
      .where(eq(creatorHandleClaims.id, canonicalClaimId)));

    await expect(db.insert(creatorPageDrafts).values({
      pageId,
      displayName: "Artist One",
      shortIntroduction: "A short introduction",
      primaryDiscipline: "unsupported",
      secondaryDisciplines: [],
      createdAt: at,
      updatedAt: at,
    })).rejects.toThrow();
    await db.insert(creatorPageDrafts).values({
      pageId,
      displayName: "Artist One",
      shortIntroduction: "A short introduction",
      primaryDiscipline: "illustration",
      secondaryDisciplines: ["drawing"],
      createdAt: at,
      updatedAt: at,
    });

    const showcaseId = randomUUID();
    await db.insert(creatorShowcaseDrafts).values({
      id: showcaseId,
      pageId,
      position: 0,
      title: "First showcase",
      description: "",
      discipline: "illustration",
      contentLabel: "general_audience",
      createdAt: at,
      updatedAt: at,
    });
    await expect(db.insert(creatorShowcaseDrafts).values({
      id: randomUUID(),
      pageId,
      position: 12,
      title: "Invalid position",
      description: "",
      discipline: "illustration",
      contentLabel: "general_audience",
      createdAt: at,
      updatedAt: at,
    })).rejects.toThrow();
    await expect(db.insert(creatorShowcaseDrafts).values({
      id: randomUUID(),
      pageId,
      position: 1,
      title: "Invalid label",
      description: "",
      discipline: "illustration",
      contentLabel: "age_restricted",
      createdAt: at,
      updatedAt: at,
    })).rejects.toThrow();
    for (const position of [0, 1, 2, 3]) {
      await db.insert(creatorShowcaseDraftMedia).values({
        id: randomUUID(),
        showcaseId,
        assetId: randomUUID(),
        position,
        alternativeText: `Image ${position + 1}`,
        createdAt: at,
        updatedAt: at,
      });
    }
    await expect(db.insert(creatorShowcaseDraftMedia).values({
      id: randomUUID(),
      showcaseId,
      assetId: randomUUID(),
      position: 4,
      alternativeText: "Fifth image",
      createdAt: at,
      updatedAt: at,
    })).rejects.toThrow();

    const revisionId = randomUUID();
    await db.insert(creatorPublicationRevisions).values({
      id: revisionId,
      pageId,
      revisionNumber: 1,
      canonicalHandle: "artist-two",
      displayName: "Artist One",
      shortIntroduction: "A short introduction",
      primaryDiscipline: "illustration",
      secondaryDisciplines: ["drawing"],
      taxonomyVersion: "v1",
      policyVersion: "general_audience.v1",
      actorUserId: userId,
      actorSessionId: "session-1",
      expectedDraftVersion: 1,
      requestId: "request-1",
      publishedAt: at,
    });
    await expect(db.insert(creatorPublicationRevisions).values({
      id: randomUUID(),
      pageId,
      revisionNumber: 1,
      canonicalHandle: "artist-two",
      displayName: "Artist One",
      shortIntroduction: "A short introduction",
      primaryDiscipline: "illustration",
      secondaryDisciplines: [],
      taxonomyVersion: "v1",
      policyVersion: "general_audience.v1",
      actorUserId: userId,
      actorSessionId: "session-2",
      expectedDraftVersion: 1,
      requestId: "request-2",
      publishedAt: at,
    })).rejects.toThrow();
    await db.update(creatorPages).set({ publishedRevisionId: revisionId }).where(eq(creatorPages.id, pageId));

    const otherUserId = `creator-catalog-user-${randomUUID()}`;
    const otherPageId = randomUUID();
    await insertUser(otherUserId, at);
    await db.insert(creatorPages).values({
      id: otherPageId,
      userId: otherUserId,
      draftVersion: 1,
      initializedFromRevisionId: randomUUID(),
      createdAt: at,
      updatedAt: at,
    });
    await expect(db.update(creatorPages).set({ publishedRevisionId: revisionId }).where(eq(creatorPages.id, otherPageId))).rejects.toThrow();

    const publicationShowcaseId = randomUUID();
    await db.insert(creatorPublicationShowcases).values({
      id: publicationShowcaseId,
      revisionId,
      sourceShowcaseId: showcaseId,
      position: 0,
      title: "First showcase",
      description: "",
      discipline: "illustration",
      contentLabel: "general_audience",
    });
    await db.insert(creatorPublicationMedia).values({
      id: randomUUID(),
      publicationShowcaseId,
      assetId: randomUUID(),
      position: 0,
      alternativeText: "Published image",
      thumbDerivativeId: randomUUID(),
      displayDerivativeId: randomUUID(),
      largeDerivativeId: randomUUID(),
    });
    await db.insert(creatorPublicationEvents).values({
      id: randomUUID(),
      pageId,
      revisionId,
      type: "published",
      actorUserId: userId,
      actorSessionId: "session-1",
      expectedDraftVersion: 1,
      requestId: "request-1",
      occurredAt: at,
    });
    await expectAppendOnly(db.update(creatorPublicationRevisions).set({ displayName: "Changed" }).where(eq(creatorPublicationRevisions.id, revisionId)));
    await expectAppendOnly(db.delete(creatorPublicationShowcases).where(eq(creatorPublicationShowcases.id, publicationShowcaseId)));
    await expectAppendOnly(db.delete(creatorPublicationEvents).where(eq(creatorPublicationEvents.pageId, pageId)));

    await db.insert(creatorDiscoveryProjections).values({
      pageId,
      revisionId,
      canonicalHandle: "artist-two",
      displayName: "Artist One",
      shortIntroduction: "A short introduction",
      disciplines: ["illustration", "drawing"],
      avatarThumbDerivativeId: null,
      revisionAt: at,
      enabled: true,
    });

    const triggers = await client<{ trigger_name: string }[]>`
      select trigger_name
      from information_schema.triggers
      where event_object_schema = ${schemaName}
        and trigger_name in (
          'creator_handle_claims_append_only',
          'creator_publication_events_append_only',
          'creator_publication_media_append_only',
          'creator_publication_revisions_append_only',
          'creator_publication_showcases_append_only',
          'creator_showcase_draft_media_limit',
          'creator_showcase_drafts_limit_active'
        )
      group by trigger_name
      order by trigger_name
    `;
    expect(triggers).toEqual([
      { trigger_name: "creator_handle_claims_append_only" },
      { trigger_name: "creator_publication_events_append_only" },
      { trigger_name: "creator_publication_media_append_only" },
      { trigger_name: "creator_publication_revisions_append_only" },
      { trigger_name: "creator_publication_showcases_append_only" },
      { trigger_name: "creator_showcase_draft_media_limit" },
      { trigger_name: "creator_showcase_drafts_limit_active" },
    ]);
  });
});
