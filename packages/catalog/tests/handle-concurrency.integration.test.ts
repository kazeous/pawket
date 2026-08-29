import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createDatabase, creatorPageDrafts, creatorPages, creatorShowcaseDraftMedia, creatorShowcaseDrafts, identityUsers, systemCommandIdempotency, systemOutbox, type PawketDatabase } from "@pawket/database";
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
type ServiceOptions = Readonly<{
  approvedRevisionId?: string;
  displayName?: string;
  introduction?: string;
  idFactory?: () => string;
  privateSentinel?: string;
}>;

function service(database = db, clock = at, options: ServiceOptions = {}) {
  const approvedRevisionId = options.approvedRevisionId ?? randomUUID();
  return createCatalogService({
    db: database,
    creatorSeeds: { async getCreatorSeed(_database, userId) { return {
      userId,
      capabilityState: "active" as const,
      capabilityVersion: 1,
      approvedRevisionId,
      displayName: options.displayName ?? "Artist",
      introduction: options.introduction ?? "Approved intro",
      portfolioUrls: options.privateSentinel ? [options.privateSentinel] : undefined,
      applicantEmail: options.privateSentinel,
    }; } },
    commandFingerprintKey: commandKey,
    now: () => clock,
    ...(options.idFactory ? { idFactory: options.idFactory } : {}),
  });
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject");
}

function postgresErrorCode(error: unknown): string | undefined {
  let current = error;
  while (current && typeof current === "object") {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    current = candidate.cause;
  }
  return undefined;
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

  test("serializes concurrent first initialization with one exact approved seed and winning event", async () => {
    // Break caught: concurrent initialization leaks a unique violation, mixes seed fields, or records the losing request correlation.
    const userId = await approvedCreator("init-race");
    const requestOne = "request-init-race-one";
    const requestTwo = "request-init-race-two";
    const pageIdOne = randomUUID();
    const pageIdTwo = randomUUID();
    const seedOne = { approvedRevisionId: randomUUID(), displayName: "Artist One", introduction: "Approved intro one", privateSentinel: "PRIVATE-PORTFOLIO-ONE" } as const;
    const seedTwo = { approvedRevisionId: randomUUID(), displayName: "Artist Two", introduction: "Approved intro two", privateSentinel: "PRIVATE-PORTFOLIO-TWO" } as const;
    const initialized = await Promise.all([
      service(db, at, { ...seedOne, idFactory: () => pageIdOne }).initialize({ userId, requestId: requestOne }),
      service(db, at, { ...seedTwo, idFactory: () => pageIdTwo }).initialize({ userId, requestId: requestTwo }),
    ]);
    expect(new Set(initialized.map((item) => item.pageId)).size).toBe(1);
    const pageId = initialized[0]!.pageId;
    expect([pageIdOne, pageIdTwo]).toContain(pageId);
    const winning = pageId === pageIdOne ? { requestId: requestOne, seed: seedOne } : { requestId: requestTwo, seed: seedTwo };
    const pageRows = await db.select().from(creatorPages).where(eq(creatorPages.userId, userId));
    expect(pageRows).toEqual([{
      id: pageId,
      userId,
      draftVersion: 1,
      publishedRevisionId: null,
      renameAvailableAt: null,
      initializedFromRevisionId: winning.seed.approvedRevisionId,
      createdAt: at,
      updatedAt: at,
    }]);
    const draftRows = await db.select().from(creatorPageDrafts).where(eq(creatorPageDrafts.pageId, pageId));
    expect(draftRows).toEqual([{
      pageId,
      displayName: winning.seed.displayName,
      shortIntroduction: winning.seed.introduction,
      primaryDiscipline: "other",
      secondaryDisciplines: [],
      avatarAssetId: null,
      coverAssetId: null,
      createdAt: at,
      updatedAt: at,
    }]);
    const initializationEvents = await db.select().from(systemOutbox).where(eq(systemOutbox.aggregateId, pageId));
    expect(initializationEvents).toHaveLength(1);
    expect({
      eventType: initializationEvents[0]?.eventType,
      eventVersion: initializationEvents[0]?.eventVersion,
      aggregateType: initializationEvents[0]?.aggregateType,
      aggregateId: initializationEvents[0]?.aggregateId,
      payload: initializationEvents[0]?.payload,
    }).toEqual({
      eventType: "creator.page_initialized.v1",
      eventVersion: 1,
      aggregateType: "creator_page",
      aggregateId: pageId,
      payload: { pageId, version: 1, correlationId: winning.requestId, actorUserId: userId },
    });
    expect(JSON.stringify({ initialized, pageRows, draftRows, initializationEvents })).not.toContain("PRIVATE-PORTFOLIO");
  });

  test("reorders a complete 12-item reverse safely", async () => {
    // Break caught: a complete reverse trips the partial unique active-position index.
    const userId = await approvedCreator("reverse"); const catalog = service(); const initialized = await catalog.initialize({ userId, requestId: "request-reverse-init" });
    const pageId = initialized.pageId;
    let version = 1; const ids: string[] = [];
    for (let position = 0; position < 12; position += 1) {
      const result = await catalog.upsertShowcase({ actor: actor(userId), pageId, expectedVersion: version, idempotencyKey: `reverse-key-${position.toString().padStart(4, "0")}`, requestId: `request-reverse-${position}`, showcase: { position, title: `Showcase ${position}`, description: "", discipline: "other", contentLabel: "general_audience", externalUrl: null, media: [] } });
      version = result.draftVersion; ids.push((await catalog.getWorkspace({ actorUserId: userId, pageId })).showcases.at(-1)!.id);
    }
    const reversed = [...ids].reverse();
    await expect(catalog.reorderShowcases({ actor: actor(userId), pageId, expectedVersion: version, idempotencyKey: "reverse-key-final", requestId: "request-reverse-final", showcaseIds: reversed })).resolves.toEqual({ pageId, draftVersion: version + 1 });
    expect((await catalog.getWorkspace({ actorUserId: userId, pageId })).showcases.map((showcase) => showcase.id)).toEqual(reversed);
  });

  test("replays committed handle claims and renames after authentication freshness expires", async () => {
    // Break caught: a previously completed idempotent handle command is rejected before replay detection solely because time elapsed.
    const userId = await approvedCreator("expired-replay"); const catalog = service(); const page = await catalog.initialize({ userId, requestId: "request-expired-replay-init" });
    const claim = { actor: actor(userId), pageId: page.pageId, expectedVersion: 1, idempotencyKey: "expired-replay-claim", requestId: "request-expired-replay-claim", handle: "replay-claim" } as const;
    const claimResult = await catalog.claimHandle(claim);
    await expect(service(db, new Date(at.getTime() + 900_001)).claimHandle({ ...claim, actor: actor(userId, new Date(at.getTime() - 900_001)) })).resolves.toEqual(claimResult);
    await expect(catalog.claimHandle({ ...claim, handle: "other-handle" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const rename = { actor: actor(userId), pageId: page.pageId, expectedVersion: 2, idempotencyKey: "expired-replay-rename", requestId: "request-expired-replay-rename", handle: "replay-renamed" } as const;
    const renameResult = await catalog.renameHandle(rename);
    await expect(service(db, new Date(at.getTime() + 900_001)).renameHandle({ ...rename, actor: actor(userId, new Date(at.getTime() - 900_001)) })).resolves.toEqual(renameResult);
    await expect(catalog.renameHandle({ ...rename, handle: "other-renamed" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  test("soft-removes the requested authoritative row while retaining its media and untouched active row", async () => {
    // Break caught: remove targets the wrong row, leaves it active, cascades draft media, or alters an untouched showcase.
    const userId = await approvedCreator("remove-authoritative"); const catalog = service(); const page = await catalog.initialize({ userId, requestId: "request-remove-authoritative-init" });
    const mediaAssetId = randomUUID();
    await catalog.upsertShowcase({ actor: actor(userId), pageId: page.pageId, expectedVersion: 1, idempotencyKey: "remove-authoritative-first", requestId: "request-remove-authoritative-first", showcase: { position: 0, title: "Remove me", description: "", discipline: "other", contentLabel: "general_audience", externalUrl: null, media: [{ assetId: mediaAssetId, alternativeText: "Retained draft media" }] } });
    await catalog.upsertShowcase({ actor: actor(userId), pageId: page.pageId, expectedVersion: 2, idempotencyKey: "remove-authoritative-second", requestId: "request-remove-authoritative-second", showcase: { position: 1, title: "Keep me", description: "", discipline: "other", contentLabel: "general_audience", externalUrl: null, media: [] } });
    const before = await catalog.getWorkspace({ actorUserId: userId, pageId: page.pageId });
    const removedId = before.showcases[0]!.id;
    const untouchedId = before.showcases[1]!.id;
    await expect(catalog.removeShowcase({ actor: actor(userId), pageId: page.pageId, expectedVersion: 3, idempotencyKey: "remove-authoritative-command", requestId: "request-remove-authoritative-command", showcaseId: removedId })).resolves.toEqual({ pageId: page.pageId, draftVersion: 4 });

    const [removedRow] = await db.select().from(creatorShowcaseDrafts).where(eq(creatorShowcaseDrafts.id, removedId));
    const [untouchedRow] = await db.select().from(creatorShowcaseDrafts).where(eq(creatorShowcaseDrafts.id, untouchedId));
    expect(removedRow?.removedAt).toEqual(at);
    expect(untouchedRow).toMatchObject({ id: untouchedId, pageId: page.pageId, position: 1, removedAt: null });
    expect((await catalog.getWorkspace({ actorUserId: userId, pageId: page.pageId })).showcases.map((showcase) => showcase.id)).toEqual([untouchedId]);
    expect(await db.select({ showcaseId: creatorShowcaseDraftMedia.showcaseId, assetId: creatorShowcaseDraftMedia.assetId, position: creatorShowcaseDraftMedia.position, alternativeText: creatorShowcaseDraftMedia.alternativeText }).from(creatorShowcaseDraftMedia).where(eq(creatorShowcaseDraftMedia.showcaseId, removedId))).toEqual([{ showcaseId: removedId, assetId: mediaAssetId, position: 0, alternativeText: "Retained draft media" }]);
  });

  test("reorders an isolated two-item swap into the exact requested workspace order", async () => {
    // Break caught: reorder proves only set equality while leaving the original position order unchanged.
    const userId = await approvedCreator("simple-swap"); const catalog = service(); const page = await catalog.initialize({ userId, requestId: "request-simple-swap-init" });
    await catalog.upsertShowcase({ actor: actor(userId), pageId: page.pageId, expectedVersion: 1, idempotencyKey: "simple-swap-first", requestId: "request-simple-swap-first", showcase: { position: 0, title: "First", description: "", discipline: "other", contentLabel: "general_audience", externalUrl: null, media: [] } });
    await catalog.upsertShowcase({ actor: actor(userId), pageId: page.pageId, expectedVersion: 2, idempotencyKey: "simple-swap-second", requestId: "request-simple-swap-second", showcase: { position: 1, title: "Second", description: "", discipline: "other", contentLabel: "general_audience", externalUrl: null, media: [] } });
    const before = await catalog.getWorkspace({ actorUserId: userId, pageId: page.pageId });
    const firstId = before.showcases[0]!.id;
    const secondId = before.showcases[1]!.id;
    await catalog.reorderShowcases({ actor: actor(userId), pageId: page.pageId, expectedVersion: 3, idempotencyKey: "simple-swap-command", requestId: "request-simple-swap-command", showcaseIds: [secondId, firstId] });
    expect((await catalog.getWorkspace({ actorUserId: userId, pageId: page.pageId })).showcases.map((showcase) => showcase.id)).toEqual([secondId, firstId]);
  });

  test("rolls back every reorder side effect when a test trigger fails after temporary deactivation", async () => {
    // Break caught: a post-start reorder failure commits temporary removals, positions, version, event, or command idempotency state.
    const userId = await approvedCreator("reorder-rollback"); const catalog = service(); const page = await catalog.initialize({ userId, requestId: "request-reorder-rollback-init" });
    await catalog.upsertShowcase({ actor: actor(userId), pageId: page.pageId, expectedVersion: 1, idempotencyKey: "reorder-rollback-first", requestId: "request-reorder-rollback-first", showcase: { position: 0, title: "First", description: "", discipline: "other", contentLabel: "general_audience", externalUrl: null, media: [] } });
    await catalog.upsertShowcase({ actor: actor(userId), pageId: page.pageId, expectedVersion: 2, idempotencyKey: "reorder-rollback-second", requestId: "request-reorder-rollback-second", showcase: { position: 1, title: "Second", description: "", discipline: "other", contentLabel: "general_audience", externalUrl: null, media: [] } });
    const workspace = await catalog.getWorkspace({ actorUserId: userId, pageId: page.pageId });
    const showcaseIds = workspace.showcases.map((showcase) => showcase.id);
    const originalRows = await db.select().from(creatorShowcaseDrafts).where(eq(creatorShowcaseDrafts.pageId, page.pageId)).orderBy(asc(creatorShowcaseDrafts.position));
    expect(originalRows.map((row) => ({ id: row.id, position: row.position, removedAt: row.removedAt }))).toEqual([
      { id: showcaseIds[0], position: 0, removedAt: null },
      { id: showcaseIds[1], position: 1, removedAt: null },
    ]);
    const [originalPage] = await db.select({ draftVersion: creatorPages.draftVersion }).from(creatorPages).where(eq(creatorPages.id, page.pageId));
    const originalEvents = await db.select({ id: systemOutbox.id }).from(systemOutbox).where(eq(systemOutbox.aggregateId, page.pageId));
    const originalIdempotency = await db.select().from(systemCommandIdempotency).where(eq(systemCommandIdempotency.actorUserId, userId)).orderBy(asc(systemCommandIdempotency.id));
    const functionName = "catalog_test_fail_reorder_position";
    const triggerName = "catalog_test_fail_reorder_position_trigger";
    await db.execute(sql.raw(`create function "${functionName}"() returns trigger language plpgsql as $$ begin raise exception 'test-only reorder position failure' using errcode = '55000'; end; $$`));
    let reorderFailure: unknown;
    try {
      await db.execute(sql.raw(`create trigger "${triggerName}" before update of position on "creator_showcase_drafts" for each row when (old.removed_at is not null) execute function "${functionName}"()`));
      try {
        reorderFailure = await rejectionOf(catalog.reorderShowcases({ actor: actor(userId), pageId: page.pageId, expectedVersion: 3, idempotencyKey: "reorder-rollback-command", requestId: "request-reorder-rollback-command", showcaseIds: [showcaseIds[1]!, showcaseIds[0]!] }));
      } finally {
        await db.execute(sql.raw(`drop trigger if exists "${triggerName}" on "creator_showcase_drafts"`));
      }
    } finally {
      await db.execute(sql.raw(`drop function if exists "${functionName}"()`));
    }
    expect(postgresErrorCode(reorderFailure)).toBe("55000");
    expect(await db.select().from(creatorShowcaseDrafts).where(eq(creatorShowcaseDrafts.pageId, page.pageId)).orderBy(asc(creatorShowcaseDrafts.position))).toEqual(originalRows);
    expect((await db.select({ draftVersion: creatorPages.draftVersion }).from(creatorPages).where(eq(creatorPages.id, page.pageId)))[0]).toEqual(originalPage);
    const afterEvents = await db.select({ id: systemOutbox.id }).from(systemOutbox).where(eq(systemOutbox.aggregateId, page.pageId));
    expect(afterEvents).toHaveLength(originalEvents.length);
    expect(new Set(afterEvents.map((event) => event.id))).toEqual(new Set(originalEvents.map((event) => event.id)));
    expect(await db.select().from(systemCommandIdempotency).where(eq(systemCommandIdempotency.actorUserId, userId)).orderBy(asc(systemCommandIdempotency.id))).toEqual(originalIdempotency);
  });

  test("reorder keeps a same-time historical removal removed", async () => {
    // Break caught: reactivation selects every row sharing the injected timestamp, including an already removed showcase.
    const userId = await approvedCreator("marker"); const catalog = service(); const page = await catalog.initialize({ userId, requestId: "request-marker-init" });
    let version = 1; const ids: string[] = [];
    for (let position = 0; position < 3; position += 1) {
      const created = await catalog.upsertShowcase({ actor: actor(userId), pageId: page.pageId, expectedVersion: version, idempotencyKey: `marker-create-${position}`, requestId: `request-marker-create-${position}`, showcase: { position, title: `Marker ${position}`, description: "", discipline: "other", contentLabel: "general_audience", externalUrl: null, media: [] } });
      version = created.draftVersion; ids.push((await catalog.getWorkspace({ actorUserId: userId, pageId: page.pageId })).showcases.at(-1)!.id);
    }
    const removed = ids[0]!;
    version = (await catalog.removeShowcase({ actor: actor(userId), pageId: page.pageId, expectedVersion: version, idempotencyKey: "marker-remove", requestId: "request-marker-remove", showcaseId: removed })).draftVersion;
    await catalog.reorderShowcases({ actor: actor(userId), pageId: page.pageId, expectedVersion: version, idempotencyKey: "marker-reorder", requestId: "request-marker-reorder", showcaseIds: [ids[2]!, ids[1]!] });
    const active = await db.select({ id: creatorShowcaseDrafts.id }).from(creatorShowcaseDrafts).where(and(eq(creatorShowcaseDrafts.pageId, page.pageId), isNull(creatorShowcaseDrafts.removedAt))).orderBy(asc(creatorShowcaseDrafts.position));
    const [historical] = await db.select().from(creatorShowcaseDrafts).where(eq(creatorShowcaseDrafts.id, removed));
    expect(active.map((row) => row.id)).toEqual([ids[2]!, ids[1]!]);
    expect((await catalog.getWorkspace({ actorUserId: userId, pageId: page.pageId })).showcases.map((showcase) => showcase.id)).toEqual([ids[2]!, ids[1]!]);
    expect(historical?.removedAt).toEqual(at);
  });
});
