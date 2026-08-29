import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createDatabase,
  creatorDiscoveryProjections,
  creatorPages,
  creatorPublicationEvents,
  creatorPublicationMedia,
  creatorPublicationRevisions,
  creatorPublicationShowcases,
  creatorShowcaseDraftMedia,
  identityUsers,
  systemCommandIdempotency,
  systemOutbox,
  type PawketDatabase,
} from "@pawket/database";
import {
  CONTENT_POLICY_VERSION,
  CatalogServiceError,
  TAXONOMY_VERSION,
  createCatalogService,
  createPublicCatalogQuery,
  type CreatorSeed,
  type MediaReference,
  type ReadyMedia,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for catalog integration tests");

const schemaName = `catalog_publication_${process.pid}_${Date.now()}`;
const migrationsDirectory = new URL("../../database/migrations/", import.meta.url);
const at = new Date("2026-08-30T04:00:00.000Z");
const commandFingerprintKey = new Uint8Array(32).fill(31);
let db: PawketDatabase;
let closeDatabase: (() => Promise<void>) | undefined;

async function migrate(filename: string): Promise<void> {
  const migration = await readFile(new URL(filename, migrationsDirectory), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await db.execute(sql.raw(statement));
  }
}

type Harness = ReturnType<typeof harness>;

function harness(input: {
  publishingMode?: "disabled" | "general_audience";
  capabilityState?: CreatorSeed["capabilityState"] | null;
  pageHeld?: boolean;
  heldShowcaseIds?: ReadonlySet<string>;
  mutateMedia?: (media: ReadyMedia, reference: MediaReference) => ReadyMedia | null;
  mutateResolvedMap?: (result: Map<string, ReadyMedia>, references: readonly MediaReference[]) => unknown;
  mutateHolds?: (snapshot: { pageHeld: boolean; heldShowcaseIds: ReadonlySet<string> }) => unknown;
} = {}) {
  let capabilityState = input.capabilityState === undefined ? "active" : input.capabilityState;
  let pageHeld = input.pageHeld ?? false;
  let heldShowcaseIds = input.heldShowcaseIds ?? new Set<string>();
  let seedInterceptor: (() => Promise<void>) | null = null;
  let failVisibility = false;
  let malformedVisibility = false;
  const media = new Map<string, ReadyMedia>();
  const creatorSeeds = {
    async getCreatorSeed(_database: unknown, userId: string): Promise<CreatorSeed | null> {
      const stateAtRead = capabilityState;
      if (stateAtRead === null) return null;
      await seedInterceptor?.();
      return {
        userId,
        capabilityState: stateAtRead,
        capabilityVersion: 7,
        approvedRevisionId: randomUUID(),
        displayName: "Approved Artist",
        introduction: "Approved introduction",
      };
    },
    async getCreatorSeeds(_database: unknown, userIds: readonly string[]) {
      return new Map(userIds.map((userId) => [userId, capabilityState === null ? null : {
        userId, capabilityState, capabilityVersion: 7, approvedRevisionId: randomUUID(), displayName: "Approved Artist", introduction: "Approved introduction",
      }] as const));
    },
  };
  const mediaCatalog = {
    async resolveReadyAssets(_database: unknown, _ownerUserId: string, references: readonly MediaReference[]) {
      const resolved = new Map<string, ReadyMedia>();
      for (const reference of references) {
        const found = media.get(reference.assetId);
        const value = found ? (input.mutateMedia?.(found, reference) ?? found) : null;
        if (value) resolved.set(reference.assetId, value);
      }
      return (input.mutateResolvedMap?.(resolved, references) ?? resolved) as ReadonlyMap<string, ReadyMedia>;
    },
    async resolveReadyAssetsBatch(_database: unknown, requests: readonly { ownerUserId: string; references: readonly MediaReference[] }[]) {
      return new Map(requests.map((request) => [request.ownerUserId, new Map(request.references.flatMap((reference) => {
        const found = media.get(reference.assetId);
        return found ? [[reference.assetId, found] as const] : [];
      }))] as const));
    },
  };
  const visibility = {
    async readHolds() {
      if (failVisibility) throw new Error("injected visibility failure");
      if (malformedVisibility) return { pageHeld: "not-a-boolean", heldShowcaseIds: new Set<string>() } as unknown as { pageHeld: boolean; heldShowcaseIds: ReadonlySet<string> };
      const snapshot = {
        pageHeld,
        heldShowcaseIds,
      };
      return (input.mutateHolds?.(snapshot) ?? snapshot) as typeof snapshot;
    },
    async readHoldsBatch(_database: unknown, requests: readonly { pageId: string; revisionId: string; showcaseIds: readonly string[] }[]) {
      return new Map(requests.map((request) => [request.pageId, { pageHeld, heldShowcaseIds }] as const));
    },
  };
  const serviceForMode = (publishingMode: "disabled" | "general_audience", withVisibility = true) => createCatalogService({
    db, creatorSeeds, mediaCatalog, publishingMode, commandFingerprintKey, now: () => at,
    ...(withVisibility ? { visibility } : {}),
  });
  const service = serviceForMode(input.publishingMode ?? "general_audience");
  const queryInput = {
    db,
    creatorSeeds,
    mediaCatalog,
    visibility,
    publishingMode: input.publishingMode ?? "general_audience",
  } as const;
  const query = {
    resolvePublicCreator(handle: string) {
      return createPublicCatalogQuery(queryInput).resolvePublicCreator(handle);
    },
  };
  return {
    service,
    serviceForMode,
    query,
    media,
    setCapability(value: CreatorSeed["capabilityState"] | null) { capabilityState = value; },
    setHolds(value: { pageHeld: boolean; heldShowcaseIds: ReadonlySet<string> }) { pageHeld = value.pageHeld; heldShowcaseIds = new Set(value.heldShowcaseIds); },
    setSeedInterceptor(value: (() => Promise<void>) | null) { seedInterceptor = value; },
    failVisibility() { failVisibility = true; },
    malformVisibility() { malformedVisibility = true; },
  };
}

function actor(userId: string) {
  return { userId, sessionId: "session-publication", primaryAuthenticatedAt: at };
}

async function approvedCreator(label: string): Promise<string> {
  const userId = `publication-${label}-${randomUUID()}`;
  await db.insert(identityUsers).values({
    id: userId,
    name: "Approved Artist",
    email: `${userId}@example.test`,
    canonicalEmail: `${userId}@example.test`,
    emailVerified: true,
    emailVerifiedAt: at,
    emailVerificationProvenance: "password_email_challenge",
    createdAt: at,
    updatedAt: at,
  });
  return userId;
}

function readyMedia(ownerUserId: string, purpose: MediaReference["purpose"]): ReadyMedia {
  return {
    assetId: randomUUID(),
    ownerUserId,
    purpose,
    derivatives: {
      thumb: { derivativeId: randomUUID(), width: 384, height: 384 },
      display: { derivativeId: randomUUID(), width: 1280, height: 900 },
      large: { derivativeId: randomUUID(), width: 2400, height: 1600 },
    },
  };
}

async function preparedPage(testHarness: Harness, label: string, options: { withHandle?: boolean; withMedia?: boolean } = {}) {
  const userId = await approvedCreator(label);
  const page = await testHarness.service.initialize({ userId, requestId: `request-${label}-initialize` });
  let version = page.draftVersion;
  if (options.withHandle !== false) {
    version = (await testHarness.service.claimHandle({
      actor: actor(userId), pageId: page.pageId, expectedVersion: version,
      idempotencyKey: `${label}-claim-key`, requestId: `request-${label}-claim`, handle: `${label}-artist`,
    })).draftVersion;
  }
  const avatar = readyMedia(userId, "avatar");
  const cover = readyMedia(userId, "cover");
  const showcaseMedia = readyMedia(userId, "showcase");
  if (options.withMedia !== false) {
    testHarness.media.set(avatar.assetId, avatar);
    testHarness.media.set(cover.assetId, cover);
    testHarness.media.set(showcaseMedia.assetId, showcaseMedia);
  }
  version = (await testHarness.service.saveDraft({
    actor: actor(userId), pageId: page.pageId, expectedVersion: version,
    idempotencyKey: `${label}-draft-key`, requestId: `request-${label}-draft`,
    draft: {
      displayName: "Before edit",
      introduction: "Published introduction",
      primaryDiscipline: "illustration",
      secondaryDisciplines: ["drawing"],
      avatarAssetId: avatar.assetId,
      coverAssetId: cover.assetId,
    },
  })).draftVersion;
  version = (await testHarness.service.upsertShowcase({
    actor: actor(userId), pageId: page.pageId, expectedVersion: version,
    idempotencyKey: `${label}-showcase-key`, requestId: `request-${label}-showcase`,
    showcase: {
      position: 0,
      title: "Published showcase",
      description: "A coherent immutable showcase",
      discipline: "illustration",
      contentLabel: "general_audience",
      externalUrl: "https://example.test/work",
      media: [{ assetId: showcaseMedia.assetId, alternativeText: "Finished illustration" }],
    },
  })).draftVersion;
  return { userId, pageId: page.pageId, version, handle: options.withHandle === false ? null : `${label}-artist`, avatar, cover, showcaseMedia };
}

function publishCommand(page: Awaited<ReturnType<typeof preparedPage>>, suffix = "one") {
  return {
    actor: actor(page.userId),
    pageId: page.pageId,
    expectedVersion: page.version,
    idempotencyKey: `publish-${suffix}-${page.pageId}`,
    requestId: `request-publish-${suffix}`,
  };
}

async function authoritativePublication(pageId: string, userId: string) {
  const [pages, projections, revisions, events, outbox, idempotency] = await Promise.all([
    db.select().from(creatorPages).where(eq(creatorPages.id, pageId)),
    db.select().from(creatorDiscoveryProjections).where(eq(creatorDiscoveryProjections.pageId, pageId)),
    db.select().from(creatorPublicationRevisions).where(eq(creatorPublicationRevisions.pageId, pageId)).orderBy(asc(creatorPublicationRevisions.revisionNumber)),
    db.select().from(creatorPublicationEvents).where(eq(creatorPublicationEvents.pageId, pageId)).orderBy(asc(creatorPublicationEvents.occurredAt)),
    db.select().from(systemOutbox).where(eq(systemOutbox.aggregateId, pageId)).orderBy(asc(systemOutbox.id)),
    db.select().from(systemCommandIdempotency).where(eq(systemCommandIdempotency.actorUserId, userId)).orderBy(asc(systemCommandIdempotency.id)),
  ]);
  const revisionIds = revisions.map((revision) => revision.id);
  const showcases = revisionIds.length === 0 ? [] : await db.select().from(creatorPublicationShowcases).where(inArray(creatorPublicationShowcases.revisionId, revisionIds)).orderBy(asc(creatorPublicationShowcases.position));
  const showcaseIds = showcases.map((showcase) => showcase.id);
  const media = showcaseIds.length === 0 ? [] : await db.select().from(creatorPublicationMedia).where(inArray(creatorPublicationMedia.publicationShowcaseId, showcaseIds)).orderBy(asc(creatorPublicationMedia.position));
  return { pages, projections, revisions, showcases, media, events, outbox, idempotency };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; } catch (error) { return error; }
  throw new Error("Expected rejection");
}

function postgresErrorCode(error: unknown): string | null {
  let current = error;
  while (current && typeof current === "object") {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    current = candidate.cause;
  }
  return null;
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

describe("creator publication", () => {
  test("publishes one coherent immutable snapshot and leaves later draft edits private", async () => {
    // Break caught: publication reads mutable drafts after commit or exposes storage/private media data.
    const testHarness = harness();
    const page = await preparedPage(testHarness, `immutable-${randomUUID().slice(0, 8)}`);
    const published = await testHarness.service.publish(publishCommand(page));
    await testHarness.service.saveDraft({
      actor: actor(page.userId), pageId: page.pageId, expectedVersion: page.version,
      idempotencyKey: `later-draft-${page.pageId}`, requestId: "request-later-private-draft",
      draft: {
        displayName: "Private later edit", introduction: "This must remain private",
        primaryDiscipline: "painting", secondaryDisciplines: [], avatarAssetId: null, coverAssetId: null,
      },
    });
    const publicPage = await testHarness.query.resolvePublicCreator(page.handle!);
    expect(publicPage).toMatchObject({ kind: "visible", page: { revisionId: published.revisionId, displayName: "Before edit" } });
    if (publicPage.kind !== "visible") throw new Error("Expected visible creator");
    expect(publicPage.page.showcases[0]?.media[0]).toEqual({
      assetId: page.showcaseMedia.assetId,
      thumbDerivativeId: page.showcaseMedia.derivatives.thumb.derivativeId,
      displayDerivativeId: page.showcaseMedia.derivatives.display.derivativeId,
      largeDerivativeId: page.showcaseMedia.derivatives.large.derivativeId,
      alternativeText: "Finished illustration",
      dimensions: {
        thumb: { width: 384, height: 384 },
        display: { width: 1280, height: 900 },
        large: { width: 2400, height: 1600 },
      },
    });
    expect(JSON.stringify(publicPage)).not.toMatch(/storage|object|session|application|approvedRevision|private later/i);
  });

  test.each([
    "disabled_mode", "suspended", "missing_handle", "held_page", "pending_asset", "wrong_owner", "wrong_purpose", "stale_version",
  ] as const)("publish fails closed for %s without authoritative side effects", async (scenario) => {
    // Break caught: one required guard is skipped or checked after publication state starts changing.
    const testHarness = harness({
      publishingMode: "general_audience",
      capabilityState: "active",
      pageHeld: scenario === "held_page",
      mutateMedia: scenario === "wrong_owner"
        ? (item) => ({ ...item, ownerUserId: `foreign-${randomUUID()}` })
        : scenario === "wrong_purpose"
          ? (item) => ({ ...item, purpose: item.purpose === "avatar" ? "cover" : "avatar" })
          : undefined,
    });
    const label = `${scenario.replaceAll("_", "-")}-${randomUUID().slice(0, 6)}`;
    const page = await preparedPage(testHarness, label, { withHandle: scenario !== "missing_handle", withMedia: scenario !== "pending_asset" });
    if (scenario === "suspended") testHarness.setCapability("suspended");
    const before = await authoritativePublication(page.pageId, page.userId);
    const publishService = scenario === "disabled_mode" ? testHarness.serviceForMode("disabled") : testHarness.service;
    await expect(publishService.publish({
      ...publishCommand(page, scenario),
      expectedVersion: scenario === "stale_version" ? page.version - 1 : page.version,
    })).rejects.toMatchObject({ code: expect.any(String) });
    expect(await authoritativePublication(page.pageId, page.userId)).toEqual(before);
  });

  test("publish fails closed for a held showcase without authoritative side effects", async () => {
    const heldShowcaseIds = new Set<string>();
    const testHarness = harness({ heldShowcaseIds });
    const page = await preparedPage(testHarness, `held-child-${randomUUID().slice(0, 6)}`);
    const workspace = await testHarness.service.getWorkspace({ actorUserId: page.userId, pageId: page.pageId });
    heldShowcaseIds.add(workspace.showcases[0]!.id);
    const before = await authoritativePublication(page.pageId, page.userId);
    await expect(testHarness.service.publish(publishCommand(page, "held-showcase"))).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    expect(await authoritativePublication(page.pageId, page.userId)).toEqual(before);
  });

  test("workspace returns authoritative capability and current published hold state", async () => {
    const testHarness = harness();
    const page = await preparedPage(testHarness, `workspace-state-${randomUUID().slice(0, 6)}`);
    const beforePublish = await testHarness.service.getWorkspace({ actorUserId: page.userId, pageId: page.pageId });
    expect(beforePublish.capabilityState).toBe("active");
    expect(beforePublish.enforcement).toEqual({ pageHeld: false, heldShowcaseIds: [] });
    const showcaseId = beforePublish.showcases[0]!.id;
    await testHarness.service.publish(publishCommand(page, "workspace-state"));
    testHarness.setHolds({ pageHeld: false, heldShowcaseIds: new Set([showcaseId]) });
    const held = await testHarness.service.getWorkspace({ actorUserId: page.userId, pageId: page.pageId });
    expect(held.capabilityState).toBe("active");
    expect(held.enforcement).toEqual({ pageHeld: false, heldShowcaseIds: [showcaseId] });
    await expect(testHarness.serviceForMode("general_audience", false).getWorkspace({ actorUserId: page.userId, pageId: page.pageId })).rejects.toThrow();
    testHarness.malformVisibility();
    await expect(testHarness.service.getWorkspace({ actorUserId: page.userId, pageId: page.pageId })).rejects.toThrow();
    testHarness.failVisibility();
    await expect(testHarness.service.getWorkspace({ actorUserId: page.userId, pageId: page.pageId })).rejects.toThrow();
  });

  test("publish and unpublish replay exact immutable outcomes and preserve revision history", async () => {
    // Break caught: replay creates another revision/event or unpublish deletes immutable children/media.
    const testHarness = harness();
    const page = await preparedPage(testHarness, `replay-${randomUUID().slice(0, 8)}`);
    const command = publishCommand(page, "replay");
    const published = await testHarness.service.publish(command);
    expect(await testHarness.service.publish(command)).toEqual(published);
    const unpublishCommand = {
      actor: actor(page.userId), pageId: page.pageId, expectedVersion: page.version,
      idempotencyKey: `unpublish-${page.pageId}`, requestId: "request-unpublish-replay",
    };
    const unpublished = await testHarness.service.unpublish(unpublishCommand);
    expect(await testHarness.service.unpublish(unpublishCommand)).toEqual(unpublished);
    const state = await authoritativePublication(page.pageId, page.userId);
    expect(state.pages[0]?.publishedRevisionId).toBeNull();
    expect(state.projections).toMatchObject([{ pageId: page.pageId, revisionId: published.revisionId, enabled: false }]);
    expect(state.revisions).toHaveLength(1);
    expect(state.showcases).toHaveLength(1);
    expect(state.media).toHaveLength(1);
    expect(state.events.map((event) => event.type)).toEqual(["published", "unpublished"]);
    expect(state.idempotency.filter((record) => record.commandScope === "catalog.page.publish" || record.commandScope === "catalog.page.unpublish").map((record) => ({
      commandScope: record.commandScope,
      status: record.status,
      resultReference: record.resultReference,
    })).sort((left, right) => left.commandScope.localeCompare(right.commandScope))).toEqual([
      { commandScope: "catalog.page.publish", status: "completed", resultReference: `catalog-publish-v1:${page.pageId}:${published.revisionId}:1:${page.handle}:${page.version}:${at.getTime()}` },
      { commandScope: "catalog.page.unpublish", status: "completed", resultReference: `catalog-unpublish-v1:${page.pageId}:${published.revisionId}:${page.version}:${at.getTime()}` },
    ]);
    const publicationEvents = state.outbox.filter((event) => event.eventType === "creator.page_published.v1" || event.eventType === "creator.page_unpublished.v1");
    expect(Object.fromEntries(publicationEvents.map((event) => [event.eventType, { eventVersion: event.eventVersion, payload: event.payload }]))).toEqual({
      "creator.page_published.v1": { eventVersion: 1, payload: { pageId: page.pageId, revisionId: published.revisionId, revisionNumber: 1, draftVersion: page.version, correlationId: "request-publish-replay", actorUserId: page.userId } },
      "creator.page_unpublished.v1": { eventVersion: 1, payload: { pageId: page.pageId, revisionId: published.revisionId, draftVersion: page.version, correlationId: "request-unpublish-replay", actorUserId: page.userId } },
    });
    expect(JSON.stringify(publicationEvents)).not.toMatch(/session|displayName|introduction|asset|storage|application/i);
  });

  test("replays original publish and unpublish outcomes after intervening draft and publication writes", async () => {
    const testHarness = harness();
    const page = await preparedPage(testHarness, `late-replay-${randomUUID().slice(0, 6)}`);
    const publishOne = publishCommand(page, "late-replay-one");
    const first = await testHarness.service.publish(publishOne);
    const changed = await testHarness.service.saveDraft({
      actor: actor(page.userId), pageId: page.pageId, expectedVersion: page.version,
      idempotencyKey: `late-replay-draft-${page.pageId}`, requestId: "request-late-replay-draft",
      draft: { displayName: "Later private draft", introduction: "Later", primaryDiscipline: "drawing", secondaryDisciplines: [], avatarAssetId: page.avatar.assetId, coverAssetId: page.cover.assetId },
    });
    const beforePublishReplay = await authoritativePublication(page.pageId, page.userId);
    expect(await testHarness.service.publish(publishOne)).toEqual(first);
    expect(await authoritativePublication(page.pageId, page.userId)).toEqual(beforePublishReplay);
    const unpublishOne = { actor: actor(page.userId), pageId: page.pageId, expectedVersion: changed.draftVersion, idempotencyKey: `late-unpublish-${page.pageId}`, requestId: "request-late-unpublish" };
    const unpublished = await testHarness.service.unpublish(unpublishOne);
    const second = await testHarness.service.publish({ ...publishCommand(page, "late-replay-two"), expectedVersion: changed.draftVersion });
    const beforeUnpublishReplay = await authoritativePublication(page.pageId, page.userId);
    expect(await testHarness.service.unpublish(unpublishOne)).toEqual(unpublished);
    const after = await authoritativePublication(page.pageId, page.userId);
    expect(after).toEqual(beforeUnpublishReplay);
    expect(after.pages[0]?.publishedRevisionId).toBe(second.revisionId);
  });

  test("replays completed publish and unpublish while suspended before fresh policy checks", async () => {
    const testHarness = harness();
    const page = await preparedPage(testHarness, `suspend-replay-${randomUUID().slice(0, 4)}`);
    const publish = publishCommand(page, "suspended-replay");
    const published = await testHarness.service.publish(publish);
    const unpublish = { actor: actor(page.userId), pageId: page.pageId, expectedVersion: page.version, idempotencyKey: `suspended-unpublish-${page.pageId}`, requestId: "request-suspended-unpublish" };
    const unpublished = await testHarness.service.unpublish(unpublish);
    const before = await authoritativePublication(page.pageId, page.userId);
    testHarness.setCapability("suspended");
    expect(await testHarness.service.publish(publish)).toEqual(published);
    expect(await testHarness.service.unpublish(unpublish)).toEqual(unpublished);
    expect(await authoritativePublication(page.pageId, page.userId)).toEqual(before);
    await expect(testHarness.service.publish({ ...publish, expectedVersion: page.version + 1 })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(testHarness.service.unpublish({ ...unpublish, expectedVersion: page.version + 1 })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(testHarness.service.publish({ ...publishCommand(page, "fresh-suspended"), idempotencyKey: `fresh-suspended-${page.pageId}` })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await authoritativePublication(page.pageId, page.userId)).toEqual(before);
  });

  test("rolls back head, projection, event, outbox, and idempotency when outbox insertion fails", async () => {
    // Break caught: a post-head outbox failure leaves a partially published aggregate.
    const testHarness = harness();
    const page = await preparedPage(testHarness, `rollback-${randomUUID().slice(0, 8)}`);
    const before = await authoritativePublication(page.pageId, page.userId);
    const functionName = `fail_catalog_outbox_${randomUUID().replaceAll("-", "")}`;
    const triggerName = `${functionName}_trigger`;
    await db.execute(sql.raw(`create function "${functionName}"() returns trigger language plpgsql as $$ begin if new.event_type = 'creator.page_published.v1' then raise exception 'injected outbox failure' using errcode = '55000'; end if; return new; end; $$`));
    try {
      await db.execute(sql.raw(`create trigger "${triggerName}" before insert on "system_outbox" for each row execute function "${functionName}"()`));
      await expect(testHarness.service.publish(publishCommand(page, "rollback"))).rejects.toThrow();
    } finally {
      await db.execute(sql.raw(`drop trigger if exists "${triggerName}" on "system_outbox"`));
      await db.execute(sql.raw(`drop function if exists "${functionName}"()`));
    }
    expect(await authoritativePublication(page.pageId, page.userId)).toEqual(before);
  });

  test("rolls back unpublish head, projection, event, outbox, and idempotency on a late outbox failure", async () => {
    const testHarness = harness();
    const page = await preparedPage(testHarness, `unpubrb-${randomUUID().slice(0, 5)}`);
    await testHarness.service.publish(publishCommand(page, "unpublish-rollback"));
    const before = await authoritativePublication(page.pageId, page.userId);
    const functionName = `fail_catalog_unpublish_${randomUUID().replaceAll("-", "")}`;
    const triggerName = `${functionName}_trigger`;
    await db.execute(sql.raw(`create function "${functionName}"() returns trigger language plpgsql as $$ begin if new.event_type = 'creator.page_unpublished.v1' then raise exception 'injected late unpublish failure' using errcode = '55000'; end if; return new; end; $$`));
    try {
      await db.execute(sql.raw(`create trigger "${triggerName}" before insert on "system_outbox" for each row execute function "${functionName}"()`));
      await expect(testHarness.service.unpublish({ actor: actor(page.userId), pageId: page.pageId, expectedVersion: page.version, idempotencyKey: `unpublish-rollback-${page.pageId}`, requestId: "request-unpublish-rollback" })).rejects.toThrow();
    } finally {
      await db.execute(sql.raw(`drop trigger if exists "${triggerName}" on "system_outbox"`));
      await db.execute(sql.raw(`drop function if exists "${functionName}"()`));
    }
    expect(await authoritativePublication(page.pageId, page.userId)).toEqual(before);
  });

  test("rolls back every publication record when media resolution fails", async () => {
    // Acceptance evidence: an unavailable/changing Media provider cannot leave an idempotency row or partial revision.
    const testHarness = harness({ mutateMedia() { throw new Error("injected media resolution failure"); } });
    const page = await preparedPage(testHarness, `media-rollback-${randomUUID().slice(0, 6)}`);
    const before = await authoritativePublication(page.pageId, page.userId);
    await expect(testHarness.service.publish(publishCommand(page, "media-rollback"))).rejects.toThrow(/media resolution failure/);
    expect(await authoritativePublication(page.pageId, page.userId)).toEqual(before);
  });

  test("assigns monotonic revision numbers while preserving every immutable prior snapshot", async () => {
    // Acceptance evidence: republish replaces only the head/projection and never overwrites revision one.
    const testHarness = harness();
    const page = await preparedPage(testHarness, `monotonic-${randomUUID().slice(0, 7)}`);
    const first = await testHarness.service.publish(publishCommand(page, "monotonic-one"));
    const second = await testHarness.service.publish(publishCommand(page, "monotonic-two"));
    expect({ first: first.revisionNumber, second: second.revisionNumber }).toEqual({ first: 1, second: 2 });
    const state = await authoritativePublication(page.pageId, page.userId);
    expect(state.pages[0]?.publishedRevisionId).toBe(second.revisionId);
    expect(state.projections[0]).toMatchObject({ revisionId: second.revisionId, enabled: true });
    expect(state.revisions.map((revision) => ({ id: revision.id, revisionNumber: revision.revisionNumber }))).toEqual([
      { id: first.revisionId, revisionNumber: 1 },
      { id: second.revisionId, revisionNumber: 2 },
    ]);
    expect(state.showcases).toHaveLength(2);
    expect(state.media).toHaveLength(2);
  });

  test("suspension clear is atomic and reinstatement never republishes", async () => {
    // Break caught: suspension clears only one public pointer or active capability reinstatement restores a prior head.
    const testHarness = harness();
    const page = await preparedPage(testHarness, `suspension-${randomUUID().slice(0, 7)}`);
    const published = await testHarness.service.publish(publishCommand(page, "suspension"));
    await expect(db.transaction((tx) => testHarness.service.clearPublishedHeadForSuspension(tx, {
      creatorUserId: page.userId,
      actorUserId: page.userId,
      actorSessionId: "owner-session",
      reasonCode: "creator_capability_suspended",
      requestId: "request-suspension-clear",
      occurredAt: at,
    }))).resolves.toEqual({ pageId: page.pageId, previousPublishedRevisionId: published.revisionId });
    testHarness.setCapability("active");
    expect(await testHarness.query.resolvePublicCreator(page.handle!)).toEqual({ kind: "not_found" });
    const state = await authoritativePublication(page.pageId, page.userId);
    expect(state.pages[0]?.publishedRevisionId).toBeNull();
    expect(state.projections[0]?.enabled).toBe(false);
    expect(state.revisions).toHaveLength(1);
    expect(state.outbox.filter((event) => event.eventType === "creator.page_unpublished.v1")).toHaveLength(1);
  });

  test("suspension clear failure rolls back an already published head and projection", async () => {
    // Break caught: a downstream visibility failure commits a half-cleared suspension state.
    const testHarness = harness();
    const page = await preparedPage(testHarness, `suspend-rollback-${randomUUID().slice(0, 6)}`);
    await testHarness.service.publish(publishCommand(page, "suspend-rollback"));
    const before = await authoritativePublication(page.pageId, page.userId);
    const functionName = `fail_catalog_suspend_${randomUUID().replaceAll("-", "")}`;
    const triggerName = `${functionName}_trigger`;
    await db.execute(sql.raw(`create function "${functionName}"() returns trigger language plpgsql as $$ begin if new.event_type = 'creator.page_unpublished.v1' then raise exception 'injected suspension failure' using errcode = '55000'; end if; return new; end; $$`));
    try {
      await db.execute(sql.raw(`create trigger "${triggerName}" before insert on "system_outbox" for each row execute function "${functionName}"()`));
      await expect(db.transaction((tx) => testHarness.service.clearPublishedHeadForSuspension(tx, {
        creatorUserId: page.userId, actorUserId: page.userId, actorSessionId: "owner-session",
        reasonCode: "creator_capability_suspended", requestId: "request-suspension-rollback", occurredAt: at,
      }))).rejects.toThrow();
    } finally {
      await db.execute(sql.raw(`drop trigger if exists "${triggerName}" on "system_outbox"`));
      await db.execute(sql.raw(`drop function if exists "${functionName}"()`));
    }
    expect(await authoritativePublication(page.pageId, page.userId)).toEqual(before);
  });

  test("serializes publish before capability read against suspension clearing", async () => {
    // Break caught: publish snapshots active capability before taking the page lock, then republishes after suspension clears.
    const testHarness = harness();
    const page = await preparedPage(testHarness, `race-${randomUUID().slice(0, 8)}`);
    let releaseSeed!: () => void;
    let signalSeedRead!: () => void;
    const seedRead = new Promise<void>((resolve) => { signalSeedRead = resolve; });
    const seedRelease = new Promise<void>((resolve) => { releaseSeed = resolve; });
    testHarness.setSeedInterceptor(async () => { signalSeedRead(); await seedRelease; });
    const publishPromise = testHarness.service.publish(publishCommand(page, "suspension-race"));
    await seedRead;

    let pageWasLockedBeforeCapabilityRead = false;
    try {
      await db.transaction((tx) => tx.execute(sql`select id from creator_pages where id = ${page.pageId} for update nowait`));
    } catch (error) {
      pageWasLockedBeforeCapabilityRead = postgresErrorCode(error) === "55P03";
    }

    let signalSuspensionStarted!: () => void;
    const suspensionStarted = new Promise<void>((resolve) => { signalSuspensionStarted = resolve; });
    testHarness.setCapability("suspended");
    const suspensionPromise = db.transaction(async (tx) => {
      signalSuspensionStarted();
      return testHarness.service.clearPublishedHeadForSuspension(tx, {
        creatorUserId: page.userId, actorUserId: page.userId, actorSessionId: "owner-session",
        reasonCode: "creator_capability_suspended", requestId: "request-race-suspension", occurredAt: at,
      });
    });
    await suspensionStarted;
    if (!pageWasLockedBeforeCapabilityRead) await suspensionPromise;
    releaseSeed();
    await publishPromise;
    if (pageWasLockedBeforeCapabilityRead) await suspensionPromise;
    testHarness.setSeedInterceptor(null);
    testHarness.setCapability("active");

    expect(pageWasLockedBeforeCapabilityRead).toBe(true);
    expect((await authoritativePublication(page.pageId, page.userId)).pages[0]?.publishedRevisionId).toBeNull();
    expect(await testHarness.query.resolvePublicCreator(page.handle!)).toEqual({ kind: "not_found" });
  });

  test.each(["missing_derivatives", "extra_variant", "malformed_derivative"] as const)("rejects malformed MediaCatalogPort result %s without TypeError or state drift", async (scenario) => {
    // Break caught: malformed provider output is dereferenced before the consumer validates its exact structural boundary.
    const testHarness = harness({ mutateMedia(item) {
      if (scenario === "missing_derivatives") return { ...item, derivatives: undefined } as unknown as ReadyMedia;
      if (scenario === "extra_variant") return { ...item, derivatives: { ...item.derivatives, master: item.derivatives.large } } as unknown as ReadyMedia;
      return { ...item, derivatives: { ...item.derivatives, thumb: { ...item.derivatives.thumb, width: 1.5 } } } as ReadyMedia;
    } });
    const page = await preparedPage(testHarness, `badmedia-${randomUUID().slice(0, 6)}`);
    const before = await authoritativePublication(page.pageId, page.userId);
    const error = await rejectionOf(testHarness.service.publish(publishCommand(page, scenario)));
    expect(error).toMatchObject({ code: "POLICY_VIOLATION" });
    expect(error).toBeInstanceOf(CatalogServiceError);
    expect(await authoritativePublication(page.pageId, page.userId)).toEqual(before);
  });

  test.each(["get_only", "missing", "extra", "wrong_key"] as const)("rejects an inexact MediaCatalogPort map (%s) without state drift", async (scenario) => {
    const testHarness = harness({ mutateResolvedMap(result, references) {
      const first = references[0]!;
      if (scenario === "get_only") return { get: result.get.bind(result) };
      if (scenario === "missing") { result.delete(first.assetId); return result; }
      const value = result.get(first.assetId)!;
      if (scenario === "extra") { result.set(randomUUID(), value); return result; }
      result.delete(first.assetId); result.set(randomUUID(), value); return result;
    } });
    const page = await preparedPage(testHarness, `badmap-${randomUUID().slice(0, 6)}`);
    const before = await authoritativePublication(page.pageId, page.userId);
    await expect(testHarness.service.publish(publishCommand(page, "bad-map"))).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    expect(await authoritativePublication(page.pageId, page.userId)).toEqual(before);
  });

  test.each(["masked_extra", "subclass", "proxy"] as const)("rejects a spoofable MediaCatalogPort map (%s) without state drift", async (scenario) => {
    let getterCalls = 0;
    const testHarness = harness({ mutateResolvedMap(result) {
      if (scenario === "subclass") return new (class extends Map<string, ReadyMedia> {})(result);
      if (scenario === "proxy") return new Proxy(result, {});
      const visibleKeys = [...result.keys()];
      result.set(randomUUID(), result.values().next().value!);
      Object.defineProperty(result, "size", { get() { getterCalls += 1; return visibleKeys.length; } });
      Object.defineProperty(result, "keys", { get() { getterCalls += 1; return () => visibleKeys.values(); } });
      Object.defineProperty(result, "get", { get() { getterCalls += 1; return Map.prototype.get.bind(result); } });
      return result;
    } });
    const page = await preparedPage(testHarness, `spoofmap-${randomUUID().slice(0, 5)}`);
    const before = await authoritativePublication(page.pageId, page.userId);
    await expect(testHarness.service.publish(publishCommand(page, `spoof-map-${scenario}`))).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    expect(getterCalls).toBe(0);
    expect(await authoritativePublication(page.pageId, page.userId)).toEqual(before);
  });

  test.each(["media_extra", "media_prototype", "media_accessor", "media_proxy", "derivative_extra", "derivative_prototype", "derivative_accessor"] as const)("rejects a non-plain or inexact ReadyMedia value (%s) without invoking accessors", async (scenario) => {
    let getterCalls = 0;
    const testHarness = harness({ mutateMedia(item) {
      if (scenario === "media_extra") return { ...item, unexpected: true } as unknown as ReadyMedia;
      if (scenario === "media_prototype") return Object.assign(Object.create({ ownerUserId: item.ownerUserId }), { assetId: item.assetId, purpose: item.purpose, derivatives: item.derivatives }) as ReadyMedia;
      if (scenario === "media_accessor") {
        const value = { ...item } as Record<string, unknown>;
        Object.defineProperty(value, "ownerUserId", { enumerable: true, get() { getterCalls += 1; return item.ownerUserId; } });
        return value as ReadyMedia;
      }
      if (scenario === "media_proxy") return new Proxy(item, {});
      const thumb = scenario === "derivative_extra"
        ? { ...item.derivatives.thumb, unexpected: true }
        : scenario === "derivative_prototype"
          ? Object.assign(Object.create({ width: item.derivatives.thumb.width }), { derivativeId: item.derivatives.thumb.derivativeId, height: item.derivatives.thumb.height })
          : (() => {
              const value = { ...item.derivatives.thumb } as Record<string, unknown>;
              Object.defineProperty(value, "width", { enumerable: true, get() { getterCalls += 1; return item.derivatives.thumb.width; } });
              return value;
            })();
      return { ...item, derivatives: { ...item.derivatives, thumb } } as ReadyMedia;
    } });
    const page = await preparedPage(testHarness, `spoofmedia-${randomUUID().slice(0, 4)}`);
    const before = await authoritativePublication(page.pageId, page.userId);
    await expect(testHarness.service.publish(publishCommand(page, `spoof-media-${scenario}`))).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    expect(getterCalls).toBe(0);
    expect(await authoritativePublication(page.pageId, page.userId)).toEqual(before);
  });

  test.each(["extra", "prototype", "accessor", "proxy", "set_masked_extra", "set_subclass", "set_proxy"] as const)("rejects a non-plain publication hold snapshot (%s) without invoking accessors", async (scenario) => {
    let getterCalls = 0;
    const testHarness = harness({ mutateHolds(snapshot) {
      if (scenario === "extra") return { ...snapshot, unexpected: true };
      if (scenario === "prototype") return Object.assign(Object.create({ pageHeld: snapshot.pageHeld }), { heldShowcaseIds: snapshot.heldShowcaseIds });
      if (scenario === "accessor") {
        const value = { ...snapshot } as Record<string, unknown>;
        Object.defineProperty(value, "pageHeld", { enumerable: true, get() { getterCalls += 1; return false; } });
        return value;
      }
      if (scenario === "proxy") return new Proxy(snapshot, {});
      let held = new Set<string>();
      if (scenario === "set_masked_extra") {
        held.add(randomUUID());
        Object.defineProperty(held, Symbol.iterator, { get() { getterCalls += 1; return () => new Set<string>().values(); } });
        Object.defineProperty(held, "has", { get() { getterCalls += 1; return () => false; } });
      } else if (scenario === "set_subclass") held = new (class extends Set<string> {})(held);
      else held = new Proxy(held, {});
      return { ...snapshot, heldShowcaseIds: held };
    } });
    const page = await preparedPage(testHarness, `spoofholds-${randomUUID().slice(0, 4)}`);
    const before = await authoritativePublication(page.pageId, page.userId);
    await expect(testHarness.service.publish(publishCommand(page, `spoof-holds-${scenario}`))).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    expect(getterCalls).toBe(0);
    expect(await authoritativePublication(page.pageId, page.userId)).toEqual(before);
  });

  test("accepts one exact map key for duplicate legitimate references to the same ready asset", async () => {
    const testHarness = harness();
    const page = await preparedPage(testHarness, `duplicate-${randomUUID().slice(0, 5)}`);
    const workspace = await testHarness.service.getWorkspace({ actorUserId: page.userId, pageId: page.pageId });
    await db.insert(creatorShowcaseDraftMedia).values({ id: randomUUID(), showcaseId: workspace.showcases[0]!.id, assetId: page.showcaseMedia.assetId, position: 1, alternativeText: "Second view of the same asset", createdAt: at, updatedAt: at });
    await expect(testHarness.service.publish(publishCommand(page, "duplicate-reference"))).resolves.toMatchObject({ revisionNumber: 1 });
    expect((await authoritativePublication(page.pageId, page.userId)).media).toHaveLength(2);
  });

  test("persists the exact current taxonomy and content-policy versions", async () => {
    // Break caught: publication stamps a legacy/default version that effective reads cannot safely compare.
    const testHarness = harness();
    const page = await preparedPage(testHarness, `policy-${randomUUID().slice(0, 8)}`);
    const published = await testHarness.service.publish(publishCommand(page, "policy"));
    const [revision] = await db.select().from(creatorPublicationRevisions).where(and(eq(creatorPublicationRevisions.id, published.revisionId), eq(creatorPublicationRevisions.pageId, page.pageId)));
    expect(revision).toMatchObject({ taxonomyVersion: TAXONOMY_VERSION, policyVersion: CONTENT_POLICY_VERSION });
  });
});
