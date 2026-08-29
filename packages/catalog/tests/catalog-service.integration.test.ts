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

  test("records one replay-safe, bounded outbox event for every authoring mutation family", async () => {
    // Break caught: a command mutates twice on replay, misses its durable event, or writes profile/session data into an event.
    const userId = await approvedCreator("event-matrix"); const catalog = service(); const page = await catalog.initialize({ userId, requestId: "matrix-init" });
    async function assertCommand(name: string, eventType: string, version: number, invoke: () => Promise<{ pageId: string; draftVersion: number }>) {
      const before = await db.select().from(systemOutbox).where(eq(systemOutbox.aggregateId, page.pageId));
      const first = await invoke();
      expect(first, `${name} first result`).toEqual({ pageId: page.pageId, draftVersion: version });
      expect((await db.select({ version: creatorPages.draftVersion }).from(creatorPages).where(eq(creatorPages.id, page.pageId)))[0]?.version, `${name} page version`).toBe(version);
      const after = await db.select().from(systemOutbox).where(eq(systemOutbox.aggregateId, page.pageId));
      expect(after).toHaveLength(before.length + 1);
      expect(after.at(-1)).toMatchObject({ eventType, eventVersion: 1, payload: { pageId: page.pageId, version, correlationId: expect.any(String), actorUserId: userId } });
      await expect(invoke(), `${name} replay`).resolves.toEqual(first);
      expect(await db.select().from(systemOutbox).where(eq(systemOutbox.aggregateId, page.pageId))).toHaveLength(after.length);
    }
    const claim = { actor: actor(userId), pageId: page.pageId, expectedVersion: 1, idempotencyKey: "matrix-claim-0001", requestId: "matrix-claim", handle: "matrix-one" } as const;
    await assertCommand("claim", "creator.handle_claimed.v1", 2, () => catalog.claimHandle(claim));
    const rename = { actor: actor(userId), pageId: page.pageId, expectedVersion: 2, idempotencyKey: "matrix-rename-0001", requestId: "matrix-rename", handle: "matrix-two" } as const;
    await assertCommand("rename", "creator.handle_renamed.v1", 3, () => catalog.renameHandle(rename));
    const draft = { actor: actor(userId), pageId: page.pageId, expectedVersion: 3, idempotencyKey: "matrix-draft-0001", requestId: "matrix-draft", draft: { displayName: "Matrix Artist", introduction: "Matrix intro", primaryDiscipline: "other", secondaryDisciplines: [], avatarAssetId: null, coverAssetId: null } } as const;
    await assertCommand("save draft", "creator.page_draft_saved.v1", 4, () => catalog.saveDraft(draft));
    const create = { actor: actor(userId), pageId: page.pageId, expectedVersion: 4, idempotencyKey: "matrix-create-0001", requestId: "matrix-create", showcase: { position: 0, title: "Before", description: "", discipline: "other", contentLabel: "general_audience", externalUrl: null, media: [{ assetId: randomUUID(), alternativeText: "Before image" }] } } as const;
    await assertCommand("showcase create", "creator.showcase_upserted.v1", 5, () => catalog.upsertShowcase(create));
    const showcaseId = (await catalog.getWorkspace({ actorUserId: userId, pageId: page.pageId })).showcases[0]!.id;
    const update = { actor: actor(userId), pageId: page.pageId, expectedVersion: 5, idempotencyKey: "matrix-update-0001", requestId: "matrix-update", showcase: { ...create.showcase, id: showcaseId, title: "After", media: [{ assetId: randomUUID(), alternativeText: "After image" }] } } as const;
    await assertCommand("showcase update", "creator.showcase_upserted.v1", 6, () => catalog.upsertShowcase(update));
    expect((await catalog.getWorkspace({ actorUserId: userId, pageId: page.pageId })).showcases[0]).toMatchObject({ id: showcaseId, title: "After", media: [{ alternativeText: "After image" }] });
    const second = { actor: actor(userId), pageId: page.pageId, expectedVersion: 6, idempotencyKey: "matrix-second-0001", requestId: "matrix-second", showcase: { ...create.showcase, position: 1, title: "Second", media: [] } } as const;
    await assertCommand("second create", "creator.showcase_upserted.v1", 7, () => catalog.upsertShowcase(second));
    const remove = { actor: actor(userId), pageId: page.pageId, expectedVersion: 7, idempotencyKey: "matrix-remove-0001", requestId: "matrix-remove", showcaseId } as const;
    await assertCommand("showcase remove", "creator.showcase_removed.v1", 8, () => catalog.removeShowcase(remove));
    const remainingId = (await catalog.getWorkspace({ actorUserId: userId, pageId: page.pageId })).showcases[0]!.id;
    const reorder = { actor: actor(userId), pageId: page.pageId, expectedVersion: 8, idempotencyKey: "matrix-reorder-0001", requestId: "matrix-reorder", showcaseIds: [remainingId] } as const;
    await assertCommand("showcase reorder", "creator.showcase_reordered.v1", 9, () => catalog.reorderShowcases(reorder));
    const serialized = JSON.stringify(await db.select().from(systemOutbox).where(eq(systemOutbox.aggregateId, page.pageId)));
    for (const forbidden of ["session", "Matrix Artist", "Matrix intro", "assetId", "alternativeText", "portfolio", "application"]) expect(serialized).not.toContain(forbidden);
  });

  test("maps active-showcase overflow to a stable policy error without partial state", async () => {
    // Break caught: the database trigger leaks its raw error when a thirteenth active showcase is attempted.
    const userId = await approvedCreator("overflow"); const catalog = service(); const page = await catalog.initialize({ userId, requestId: "overflow-init" });
    let version = 1;
    for (let position = 0; position < 12; position += 1) version = (await catalog.upsertShowcase({ actor: actor(userId), pageId: page.pageId, expectedVersion: version, idempotencyKey: `overflow-key-${position}`, requestId: `overflow-${position}`, showcase: { position, title: `Item ${position}`, description: "", discipline: "other", contentLabel: "general_audience", externalUrl: null, media: [] } })).draftVersion;
    await expect(catalog.upsertShowcase({ actor: actor(userId), pageId: page.pageId, expectedVersion: version, idempotencyKey: "overflow-key-last", requestId: "overflow-last", showcase: { position: 11, title: "Thirteenth", description: "", discipline: "other", contentLabel: "general_audience", externalUrl: null, media: [] } })).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    expect((await catalog.getWorkspace({ actorUserId: userId, pageId: page.pageId })).showcases).toHaveLength(12);
  });
});
