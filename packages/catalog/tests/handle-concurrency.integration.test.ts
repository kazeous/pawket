import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createDatabase, identityUsers, type PawketDatabase } from "@pawket/database";
import { createCatalogService, HANDLE_RENAME_COOLDOWN_MS } from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for catalog integration tests");
const schemaName = `catalog_handles_${process.pid}_${Date.now()}`;
let db: PawketDatabase;
let closeDatabase: (() => Promise<void>) | undefined;
const migrationsDirectory = new URL("../../database/migrations/", import.meta.url);
const at = new Date("2026-08-29T03:00:00.000Z");
const commandKey = new Uint8Array(32).fill(9);

async function migrate(filename: string): Promise<void> {
  const migration = await readFile(new URL(filename, migrationsDirectory), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) if (statement.trim()) await db.execute(sql.raw(statement));
}

async function approvedCreator(label: string): Promise<string> {
  const userId = `handle-${label}-${randomUUID()}`;
  await db.insert(identityUsers).values({ id: userId, name: "Artist", email: `${userId}@example.test`, canonicalEmail: `${userId}@example.test`, emailVerified: true, emailVerifiedAt: at, emailVerificationProvenance: "password_email_challenge", createdAt: at, updatedAt: at });
  return userId;
}

function actor(userId: string, primaryAuthenticatedAt = at) { return { userId, sessionId: "handle-session", primaryAuthenticatedAt }; }
function service(database = db) {
  return createCatalogService({
    db: database,
    creatorSeeds: { async getCreatorSeed(_database, userId) { return { userId, capabilityState: "active" as const, capabilityVersion: 1, approvedRevisionId: randomUUID(), displayName: "Artist", introduction: "Approved intro" }; } },
    commandFingerprintKey: commandKey,
    now: () => at,
  });
}

beforeAll(async () => {
  const root = createDatabase(databaseUrl);
  await root.db.execute(sql.raw(`create schema "${schemaName}"`));
  await root.close();
  const connection = createDatabase(`${databaseUrl}?options=-csearch_path%3D${schemaName},public`);
  db = connection.db;
  closeDatabase = connection.close;
  for (const migrationFile of (await readdir(migrationsDirectory)).filter((entry) => entry.endsWith(".sql")).sort()) await migrate(migrationFile);
});
afterAll(async () => {
  await closeDatabase?.();
  const root = createDatabase(databaseUrl);
  await root.db.execute(sql.raw(`drop schema if exists "${schemaName}" cascade`));
  await root.close();
});

describe("catalog handle lifecycle", () => {
  test("rename preserves a permanent alias and starts a 30-day cooldown", async () => {
    // Break caught: renaming releases an old public identity or allows an immediate second rename.
    const userId = await approvedCreator("rename"); const catalog = service(); const page = await catalog.initialize({ userId, requestId: "request-handle-initialize" });
    await catalog.claimHandle({ actor: actor(userId), pageId: page.pageId, expectedVersion: 1, idempotencyKey: "claim-key-0001", requestId: "request-claim-one", handle: "artist-one" });
    const renamed = await catalog.renameHandle({ actor: actor(userId), pageId: page.pageId, expectedVersion: 2, idempotencyKey: "rename-key-0001", requestId: "request-rename-one", handle: "artist-two" });
    const renamedWorkspace = await catalog.getWorkspace({ actorUserId: userId, pageId: page.pageId });
    expect(renamedWorkspace.canonicalHandle).toBe("artist-two"); expect(renamedWorkspace.aliases).toContain("artist-one");
    if (!renamedWorkspace.renameAvailableAt) throw new Error("Expected rename cooldown");
    expect(renamedWorkspace.renameAvailableAt.toISOString()).toBe("2026-09-28T03:00:00.000Z");
    await expect(catalog.renameHandle({ actor: actor(userId), pageId: page.pageId, expectedVersion: renamed.draftVersion, idempotencyKey: "rename-key-0002", requestId: "request-rename-two", handle: "artist-three" })).rejects.toMatchObject({ code: "RENAME_COOLDOWN" });
    expect(HANDLE_RENAME_COOLDOWN_MS).toBe(2_592_000_000);
  });

  test("requires a recent primary authentication and gives concurrent claim losers no ownership detail", async () => {
    // Break caught: an old session can take a public handle, or a unique-index collision reveals the competing creator.
    const firstUserId = await approvedCreator("one"); const secondUserId = await approvedCreator("two"); const catalog = service();
    const firstPage = await catalog.initialize({ userId: firstUserId, requestId: "request-concurrent-first" }); const secondPage = await catalog.initialize({ userId: secondUserId, requestId: "request-concurrent-second" });
    await expect(catalog.claimHandle({ actor: actor(firstUserId, new Date(at.getTime() - 900_001)), pageId: firstPage.pageId, expectedVersion: 1, idempotencyKey: "expired-key-0001", requestId: "request-expired", handle: "expired-handle" })).rejects.toMatchObject({ code: "RECENT_AUTH_REQUIRED" });
    const outcomes = await Promise.allSettled([
      catalog.claimHandle({ actor: actor(firstUserId), pageId: firstPage.pageId, expectedVersion: 1, idempotencyKey: "winner-key-0001", requestId: "request-winner", handle: "same-handle" }),
      catalog.claimHandle({ actor: actor(secondUserId), pageId: secondPage.pageId, expectedVersion: 1, idempotencyKey: "loser-key-0001", requestId: "request-loser", handle: "same-handle" }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "HANDLE_UNAVAILABLE" } });
    expect(JSON.stringify(rejected)).not.toContain(firstUserId); expect(JSON.stringify(rejected)).not.toContain(secondUserId);
  });

  test("serializes concurrent first initialization and reorders a complete reverse safely", async () => {
    // Break caught: concurrent initialization leaks a unique violation or an ordinary position swap trips the partial unique index.
    const userId = await approvedCreator("init-race"); const catalog = service();
    const initialized = await Promise.all([catalog.initialize({ userId, requestId: "request-init-race-one" }), service().initialize({ userId, requestId: "request-init-race-two" })]);
    expect(new Set(initialized.map((item) => item.pageId)).size).toBe(1);
    const pageId = initialized[0]!.pageId;
    let version = 1; const ids: string[] = [];
    for (let position = 0; position < 12; position += 1) {
      const result = await catalog.upsertShowcase({ actor: actor(userId), pageId, expectedVersion: version, idempotencyKey: `reverse-key-${position.toString().padStart(4, "0")}`, requestId: `request-reverse-${position}`, showcase: { position, title: `Showcase ${position}`, description: "", discipline: "other", contentLabel: "general_audience", externalUrl: null, media: [] } });
      version = result.draftVersion; ids.push((await catalog.getWorkspace({ actorUserId: userId, pageId })).showcases.at(-1)!.id);
    }
    const reversed = [...ids].reverse();
    await expect(catalog.reorderShowcases({ actor: actor(userId), pageId, expectedVersion: version, idempotencyKey: "reverse-key-final", requestId: "request-reverse-final", showcaseIds: reversed })).resolves.toEqual({ pageId, draftVersion: version + 1 });
    expect((await catalog.getWorkspace({ actorUserId: userId, pageId })).showcases.map((showcase) => showcase.id)).toEqual(reversed);
  });
});
