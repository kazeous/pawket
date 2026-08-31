import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import {
  createDatabase,
  creatorPageDrafts,
  creatorPages,
  creatorShowcaseDraftMedia,
  creatorShowcaseDrafts,
  identityUsers,
  type PawketDatabase,
} from "@pawket/database";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createCatalogMediaOwnershipPort } from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for Catalog media ownership tests");

const schemaName = `catalog_media_ownership_${process.pid}_${Date.now()}`;
const migrationsDirectory = new URL("../../database/migrations/", import.meta.url);
const at = new Date("2026-08-31T12:00:00.000Z");
let db: PawketDatabase;
let closeDatabase: (() => Promise<void>) | undefined;

async function migrate(filename: string): Promise<void> {
  const migration = await readFile(new URL(filename, migrationsDirectory), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await db.execute(sql.raw(statement));
  }
}

beforeAll(async () => {
  const root = createDatabase(databaseUrl);
  await root.db.execute(sql.raw(`create schema "${schemaName}"`));
  await root.close();
  const connection = createDatabase(`${databaseUrl}?options=-csearch_path%3D${schemaName},public`);
  db = connection.db;
  closeDatabase = connection.close;
  for (const migration of (await readdir(migrationsDirectory)).filter((entry) => entry.endsWith(".sql")).sort()) {
    await migrate(migration);
  }
});

afterAll(async () => {
  await closeDatabase?.();
  const root = createDatabase(databaseUrl);
  await root.db.execute(sql.raw(`drop schema if exists "${schemaName}" cascade`));
  await root.close();
});

describe("Catalog-owned Public Media authorization", () => {
  test("accepts only the owned asset in its exact active Catalog relationship", async () => {
    // Catches a page-existence shortcut authorizing a foreign asset, wrong purpose, or removed showcase relationship.
    const ownerUserId = `catalog-media-owner-${randomUUID()}`;
    const otherUserId = `catalog-media-other-${randomUUID()}`;
    const missingPageUserId = `catalog-media-missing-${randomUUID()}`;
    const pageId = randomUUID();
    const otherPageId = randomUUID();
    const avatarAssetId = randomUUID();
    const coverAssetId = randomUUID();
    const showcaseAssetId = randomUUID();
    const removedShowcaseAssetId = randomUUID();
    const otherAssetId = randomUUID();
    const activeShowcaseId = randomUUID();
    const removedShowcaseId = randomUUID();

    await db.insert(identityUsers).values([ownerUserId, otherUserId, missingPageUserId].map((id) => ({
      id,
      name: "Catalog media creator",
      email: `${id}@example.test`,
      canonicalEmail: `${id}@example.test`,
      emailVerified: true,
      emailVerifiedAt: at,
      emailVerificationProvenance: "password_email_challenge" as const,
      createdAt: at,
      updatedAt: at,
    })));
    await db.insert(creatorPages).values([
      { id: pageId, userId: ownerUserId, draftVersion: 1, initializedFromRevisionId: randomUUID(), createdAt: at, updatedAt: at },
      { id: otherPageId, userId: otherUserId, draftVersion: 1, initializedFromRevisionId: randomUUID(), createdAt: at, updatedAt: at },
    ]);
    await db.insert(creatorPageDrafts).values([
      { pageId, displayName: "Owner", shortIntroduction: "Owner intro", primaryDiscipline: "illustration", secondaryDisciplines: [], avatarAssetId, coverAssetId, createdAt: at, updatedAt: at },
      { pageId: otherPageId, displayName: "Other", shortIntroduction: "Other intro", primaryDiscipline: "drawing", secondaryDisciplines: [], avatarAssetId: otherAssetId, coverAssetId: null, createdAt: at, updatedAt: at },
    ]);
    await db.insert(creatorShowcaseDrafts).values([
      { id: activeShowcaseId, pageId, position: 0, title: "Active", description: "", discipline: "other", contentLabel: "general_audience", removedAt: null, createdAt: at, updatedAt: at },
      { id: removedShowcaseId, pageId, position: 1, title: "Removed", description: "", discipline: "other", contentLabel: "general_audience", removedAt: at, createdAt: at, updatedAt: at },
    ]);
    await db.insert(creatorShowcaseDraftMedia).values([
      { id: randomUUID(), showcaseId: activeShowcaseId, assetId: showcaseAssetId, position: 0, alternativeText: "Active art", createdAt: at, updatedAt: at },
      { id: randomUUID(), showcaseId: removedShowcaseId, assetId: removedShowcaseAssetId, position: 0, alternativeText: "Removed art", createdAt: at, updatedAt: at },
    ]);

    const port = createCatalogMediaOwnershipPort();
    await expect(port.ownsAsset(db, ownerUserId, avatarAssetId, "avatar")).resolves.toBe(true);
    await expect(port.ownsAsset(db, ownerUserId, coverAssetId, "cover")).resolves.toBe(true);
    await expect(port.ownsAsset(db, ownerUserId, showcaseAssetId, "showcase")).resolves.toBe(true);

    await expect(port.ownsAsset(db, otherUserId, avatarAssetId, "avatar")).resolves.toBe(false);
    await expect(port.ownsAsset(db, ownerUserId, otherAssetId, "avatar")).resolves.toBe(false);
    await expect(port.ownsAsset(db, ownerUserId, coverAssetId, "avatar")).resolves.toBe(false);
    await expect(port.ownsAsset(db, ownerUserId, avatarAssetId, "showcase")).resolves.toBe(false);
    await expect(port.ownsAsset(db, ownerUserId, removedShowcaseAssetId, "showcase")).resolves.toBe(false);
    await expect(port.ownsAsset(db, missingPageUserId, avatarAssetId, "avatar")).resolves.toBe(false);
  });
});
