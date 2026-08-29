import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  creatorPages,
  creatorPageDrafts,
  identityUsers,
  systemOutbox,
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

function service(capabilityState: "active" | "suspended" | null = "active") {
  return createCatalogService({
    db,
    creatorSeeds: {
      async getCreatorSeed(_database, userId) {
        if (capabilityState === null) return null;
        return { userId, capabilityState, capabilityVersion: 1, approvedRevisionId: randomUUID(), displayName: "Approved Artist", introduction: "Approved intro" };
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
    expect((await catalog.getWorkspace({ actorUserId: userId, pageId: page.pageId })).showcases[0]).toMatchObject({ title: "Café", externalUrl: "https://example.test/work", media: [{ alternativeText: "Café work" }] });
    await expect(catalog.upsertShowcase({
      actor: actor(userId), pageId: page.pageId, expectedVersion: created.draftVersion, idempotencyKey: "showcase-key-0002", requestId: "request-showcase-two",
      showcase: { position: 1, title: "Unsafe", description: "", discipline: "not-a-discipline", contentLabel: "general_audience", externalUrl: "http://example.test", media: Array.from({ length: 5 }, () => ({ assetId: randomUUID(), alternativeText: "image" })) },
    })).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
  });

  test("replay remains the original stable command outcome after a later write", async () => {
    // Break caught: replay reads mutable workspace content then labels it with the old version.
    const userId = await approvedCreator("replay");
    const catalog = service();
    const page = await catalog.initialize({ userId, requestId: "request-replay-initialize" });
    const first = { actor: actor(userId), pageId: page.pageId, expectedVersion: 1, idempotencyKey: "replay-key-0001", requestId: "request-replay-first", draft: { displayName: "First", introduction: "First intro", primaryDiscipline: "other", secondaryDisciplines: [], avatarAssetId: null, coverAssetId: null } } as const;
    const firstOutcome = await catalog.saveDraft(first);
    await catalog.saveDraft({ ...first, expectedVersion: 2, idempotencyKey: "replay-key-0002", requestId: "request-replay-second", draft: { ...first.draft, displayName: "Second" } });
    await expect(catalog.saveDraft(first)).resolves.toEqual(firstOutcome);
    expect(firstOutcome).toEqual({ pageId: page.pageId, draftVersion: 2 });
  });

  test("requires a current creator capability for private workspace reads while allowing suspended remediation", async () => {
    // Break caught: a page remains readable after the capability is absent, or suspension blocks private remediation.
    const userId = await approvedCreator("capability");
    const page = await service().initialize({ userId, requestId: "request-capability-initialize" });
    await expect(service(null).getWorkspace({ actorUserId: userId, pageId: page.pageId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service("suspended").getWorkspace({ actorUserId: userId, pageId: page.pageId })).resolves.toMatchObject({ pageId: page.pageId });
    await expect(service("suspended").saveDraft({ actor: actor(userId), pageId: page.pageId, expectedVersion: 1, idempotencyKey: "suspended-key-0001", requestId: "request-suspended-draft", draft: { displayName: "Remediation", introduction: "Private changes", primaryDiscipline: "other", secondaryDisciplines: [], avatarAssetId: null, coverAssetId: null } })).resolves.toEqual({ pageId: page.pageId, draftVersion: 2 });
    await expect(service("suspended").claimHandle({ actor: actor(userId), pageId: page.pageId, expectedVersion: 2, idempotencyKey: "suspended-key-0002", requestId: "request-suspended-handle", handle: "blocked-handle" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("rejects malformed UUID command paths before PostgreSQL casts", async () => {
    // Break caught: malformed identifiers escaping as driver errors rather than stable command failures.
    const userId = await approvedCreator("uuid"); const catalog = service(); const page = await catalog.initialize({ userId, requestId: "request-uuid-initialize" });
    await expect(catalog.getWorkspace({ actorUserId: userId, pageId: "not-a-uuid" })).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    await expect(catalog.saveDraft({ actor: actor(userId), pageId: page.pageId, expectedVersion: 1, idempotencyKey: "uuid-key-0001", requestId: "request-uuid-draft", draft: { displayName: "Artist", introduction: "Intro", primaryDiscipline: "other", secondaryDisciplines: [], avatarAssetId: "not-a-uuid", coverAssetId: null } })).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    await expect(catalog.upsertShowcase({ actor: actor(userId), pageId: page.pageId, expectedVersion: 1, idempotencyKey: "uuid-key-0002", requestId: "request-uuid-showcase", showcase: { position: 0, title: "Title", description: "", discipline: "other", contentLabel: "general_audience", externalUrl: null, media: [{ assetId: "not-a-uuid", alternativeText: "Alt" }] } })).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    await expect(catalog.removeShowcase({ actor: actor(userId), pageId: page.pageId, expectedVersion: 1, idempotencyKey: "uuid-key-0003", requestId: "request-uuid-remove", showcaseId: "not-a-uuid" })).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
  });

  test("writes bounded versioned creator events without profile content", async () => {
    // Break caught: outbox types drift or private draft copy leaks into durable event payloads.
    const userId = await approvedCreator("outbox"); const catalog = service(); const page = await catalog.initialize({ userId, requestId: "request-outbox-initialize" });
    await catalog.claimHandle({ actor: actor(userId), pageId: page.pageId, expectedVersion: 1, idempotencyKey: "outbox-key-0001", requestId: "request-outbox-claim", handle: "outbox-artist" });
    const events = await db.select().from(systemOutbox).where(eq(systemOutbox.aggregateId, page.pageId));
    expect(events.map((event) => event.eventType)).toEqual(["creator.page_initialized.v1", "creator.handle_claimed.v1"]);
    expect(events.map((event) => event.payload)).toEqual([
      { pageId: page.pageId, version: 1, correlationId: "request-outbox-initialize", actorUserId: userId },
      { pageId: page.pageId, version: 2, correlationId: "request-outbox-claim", actorUserId: userId },
    ]);
    expect(JSON.stringify(events)).not.toContain("Approved Artist");
    expect(JSON.stringify(events)).not.toContain("session-catalog");
  });

  test("reorders an empty private catalog without generating invalid SQL", async () => {
    // Break caught: an empty reorder emits CASE END and fails instead of preserving the valid empty order.
    const userId = await approvedCreator("empty-reorder"); const catalog = service(); const page = await catalog.initialize({ userId, requestId: "request-empty-initialize" });
    await expect(catalog.reorderShowcases({ actor: actor(userId), pageId: page.pageId, expectedVersion: 1, idempotencyKey: "empty-key-0001", requestId: "request-empty-reorder", showcaseIds: [] })).resolves.toEqual({ pageId: page.pageId, draftVersion: 2 });
    expect((await catalog.getWorkspace({ actorUserId: userId, pageId: page.pageId })).showcases).toEqual([]);
  });

  test("rolls back the aggregate version when the authoritative draft row is missing", async () => {
    // Break caught: a corrupted/missing draft row silently increments the page version.
    const userId = await approvedCreator("draft-corruption"); const catalog = service(); const page = await catalog.initialize({ userId, requestId: "request-corruption-initialize" });
    await db.delete(creatorPageDrafts).where(eq(creatorPageDrafts.pageId, page.pageId));
    await expect(catalog.saveDraft({ actor: actor(userId), pageId: page.pageId, expectedVersion: 1, idempotencyKey: "corrupt-key-0001", requestId: "request-corrupt-save", draft: { displayName: "Artist", introduction: "Intro", primaryDiscipline: "other", secondaryDisciplines: [], avatarAssetId: null, coverAssetId: null } })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const [stored] = await db.select({ draftVersion: creatorPages.draftVersion }).from(creatorPages).where(eq(creatorPages.id, page.pageId));
    expect(stored?.draftVersion).toBe(1);
  });
});
