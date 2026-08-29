import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  creatorPages,
  identityUsers,
  createDatabase,
  type PawketDatabase,
} from "@pawket/database";
import { createCatalogService } from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for catalog integration tests");

const schemaName = `catalog_service_${process.pid}_${Date.now()}`;
let db: PawketDatabase;
let closeDatabase: (() => Promise<void>) | undefined;
const migrationsDirectory = new URL("../../database/migrations/", import.meta.url);
const at = new Date("2026-08-29T03:00:00.000Z");
const commandKey = new Uint8Array(32).fill(7);

async function migrate(filename: string): Promise<void> {
  const migration = await readFile(new URL(filename, migrationsDirectory), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await db.execute(sql.raw(statement));
  }
}

async function approvedCreator(label: string): Promise<string> {
  const userId = `catalog-${label}-${randomUUID()}`;
  await db.insert(identityUsers).values({
    id: userId, name: "Approved Artist", email: `${userId}@example.test`, canonicalEmail: `${userId}@example.test`,
    emailVerified: true, emailVerifiedAt: at, emailVerificationProvenance: "password_email_challenge", createdAt: at, updatedAt: at,
  });
  return userId;
}

function service() {
  return createCatalogService({
    db,
    creatorSeeds: {
      async getCreatorSeed(_database, userId) {
        return { userId, capabilityState: "active" as const, capabilityVersion: 1, approvedRevisionId: randomUUID(), displayName: "Approved Artist", introduction: "Approved intro" };
      },
    },
    commandFingerprintKey: commandKey,
    now: () => at,
  });
}

function actor(userId: string) {
  return { userId, sessionId: "session-catalog", primaryAuthenticatedAt: new Date(at) };
}

beforeAll(async () => {
  const root = createDatabase(databaseUrl);
  await root.db.execute(sql.raw(`create schema "${schemaName}"`));
  await root.close();
  const connection = createDatabase(`${databaseUrl}?options=-csearch_path%3D${schemaName},public`);
  db = connection.db;
  closeDatabase = connection.close;
  for (const migration of (await readdir(migrationsDirectory)).filter((entry) => entry.endsWith(".sql")).sort()) await migrate(migration);
});

afterAll(async () => {
  await closeDatabase?.();
  const root = createDatabase(databaseUrl);
  await root.db.execute(sql.raw(`drop schema if exists "${schemaName}" cascade`));
  await root.close();
});

describe("catalog authoring service", () => {
  test("initializes once from only approved display name and introduction and never publishes", async () => {
    // Break caught: initialization copying a private application field, creating a second page, or publishing implicitly.
    const userId = await approvedCreator("seed");
    const catalog = service();
    const first = await catalog.initialize({ userId, requestId: "request-initialize-one" });
    const second = await catalog.initialize({ userId, requestId: "request-initialize-two" });

    expect(second.pageId).toBe(first.pageId);
    expect(second.draft).toMatchObject({ displayName: "Approved Artist", introduction: "Approved intro" });
    expect(second.publishedRevisionId).toBeNull();
    expect(JSON.stringify(second)).not.toContain("portfolio");
    expect(await db.select().from(creatorPages)).toHaveLength(1);
  });

  test("enforces ownership, versions, and idempotent draft replay without leaking a foreign page", async () => {
    // Break caught: a stale or cross-account command changing a private draft, or reusing an idempotency key for another body.
    const userId = await approvedCreator("owner");
    const otherUserId = await approvedCreator("other");
    const catalog = service();
    const initialized = await catalog.initialize({ userId, requestId: "request-owner-initialize" });
    const command = {
      actor: actor(userId), pageId: initialized.pageId, expectedVersion: 1, idempotencyKey: "draft-key-0001", requestId: "request-draft-one",
      draft: { displayName: "Café Artist", introduction: "A safe introduction", primaryDiscipline: "illustration", secondaryDisciplines: ["drawing"], avatarAssetId: null, coverAssetId: null },
    } as const;
    const saved = await catalog.saveDraft(command);
    const replayed = await catalog.saveDraft(command);
    expect(replayed.draftVersion).toBe(saved.draftVersion);
    await expect(catalog.saveDraft({ ...command, draft: { ...command.draft, displayName: "Different Artist" } })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(catalog.saveDraft({ ...command, actor: actor(otherUserId), expectedVersion: saved.draftVersion, idempotencyKey: "draft-key-0002" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(catalog.saveDraft({ ...command, expectedVersion: 1, idempotencyKey: "draft-key-0003" })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  test("keeps showcase drafts private while enforcing approved authored content constraints", async () => {
    // Break caught: unsafe portfolio content, non-NFC alternative text, or a fifth private media reference being accepted.
    const userId = await approvedCreator("showcase");
    const catalog = service();
    const page = await catalog.initialize({ userId, requestId: "request-showcase-initialize" });
    const created = await catalog.upsertShowcase({
      actor: actor(userId), pageId: page.pageId, expectedVersion: 1, idempotencyKey: "showcase-key-0001", requestId: "request-showcase-one",
      showcase: { position: 0, title: "Café", description: "", discipline: "illustration", contentLabel: "general_audience", externalUrl: "https://example.test/work", media: [{ assetId: randomUUID(), alternativeText: "Cafe\u0301 work" }] },
    });
    expect(created.showcases[0]).toMatchObject({ title: "Café", externalUrl: "https://example.test/work", media: [{ alternativeText: "Café work" }] });
    await expect(catalog.upsertShowcase({
      actor: actor(userId), pageId: page.pageId, expectedVersion: created.draftVersion, idempotencyKey: "showcase-key-0002", requestId: "request-showcase-two",
      showcase: { position: 1, title: "Unsafe", description: "", discipline: "not-a-discipline", contentLabel: "general_audience", externalUrl: "http://example.test", media: Array.from({ length: 5 }, () => ({ assetId: randomUUID(), alternativeText: "image" })) },
    })).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
  });
});
