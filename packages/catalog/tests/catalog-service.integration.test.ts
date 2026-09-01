import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  creatorHandleClaims,
  creatorPages,
  creatorPageDrafts,
  creatorShowcaseDraftMedia,
  creatorShowcaseDrafts,
  identityUsers,
  systemCommandIdempotency,
  systemOutbox,
  createDatabase,
  type PawketDatabase,
} from "@pawket/database";
import { CatalogServiceError, createCatalogService } from "../src/index.js";

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

function service(
  capabilityState: "active" | "suspended" | null = "active",
  publishingMode: "disabled" | "general_audience" = "general_audience",
  ownedMediaState: "awaiting_upload" | "pending" | "processing" | "ready" | "failed" = "pending",
) {
  return createCatalogService({
    db,
    creatorSeeds: {
      async getCreatorSeed(_database, userId) {
        if (capabilityState === null) return null;
        return { userId, capabilityState, capabilityVersion: 1, approvedRevisionId: randomUUID(), displayName: "Approved Artist", introduction: "Approved intro" };
      },
      async getCreatorSeeds(_database, userIds) {
        return new Map(userIds.map((userId) => [userId, capabilityState === null ? null : { userId, capabilityState, capabilityVersion: 1, approvedRevisionId: randomUUID(), displayName: "Approved Artist", introduction: "Approved intro" }] as const));
      },
    },
    mediaCatalog: {
      async resolveOwnedAssets(_database, ownerUserId, references) {
        return new Map(references.map((reference) => [reference.assetId, {
          assetId: reference.assetId,
          ownerUserId,
          purpose: reference.purpose,
          state: ownedMediaState,
          derivatives: ownedMediaState === "ready" ? {
            thumb: { derivativeId: randomUUID(), width: 384, height: 384 },
            display: { derivativeId: randomUUID(), width: 1280, height: 900 },
            large: { derivativeId: randomUUID(), width: 2400, height: 1600 },
          } : {},
        }]));
      },
      async resolveReadyAssets(_database, ownerUserId, references) {
        return new Map(references.map((reference) => [reference.assetId, {
          assetId: reference.assetId,
          ownerUserId,
          purpose: reference.purpose,
          derivatives: {
            thumb: { derivativeId: randomUUID(), width: 384, height: 384 },
            display: { derivativeId: randomUUID(), width: 1280, height: 900 },
            large: { derivativeId: randomUUID(), width: 2400, height: 1600 },
          },
        }]));
      },
      async resolveReadyAssetsBatch() { return new Map(); },
    },
    commandFingerprintKey: commandKey,
    publishingMode,
    now: () => at,
  });
}

function actor(userId: string) {
  return { userId, sessionId: "session-catalog", primaryAuthenticatedAt: new Date(at) };
}

type AuthoritativeStateScope = Readonly<{
  pageIds: readonly string[];
  actorUserIds: readonly string[];
}>;

async function authoritativeState(scope: AuthoritativeStateScope) {
  const [pages, drafts, handles, showcases, outbox, idempotency] = await Promise.all([
    db.select().from(creatorPages).where(inArray(creatorPages.id, [...scope.pageIds])).orderBy(asc(creatorPages.id)),
    db.select().from(creatorPageDrafts).where(inArray(creatorPageDrafts.pageId, [...scope.pageIds])).orderBy(asc(creatorPageDrafts.pageId)),
    db.select().from(creatorHandleClaims).where(inArray(creatorHandleClaims.pageId, [...scope.pageIds])).orderBy(asc(creatorHandleClaims.id)),
    db.select().from(creatorShowcaseDrafts).where(inArray(creatorShowcaseDrafts.pageId, [...scope.pageIds])).orderBy(asc(creatorShowcaseDrafts.id)),
    db.select().from(systemOutbox).where(inArray(systemOutbox.aggregateId, [...scope.pageIds])).orderBy(asc(systemOutbox.id)),
    db.select().from(systemCommandIdempotency).where(inArray(systemCommandIdempotency.actorUserId, [...scope.actorUserIds])).orderBy(asc(systemCommandIdempotency.id)),
  ]);
  const showcaseIds = showcases.map((showcase) => showcase.id);
  const media = showcaseIds.length === 0
    ? []
    : await db.select().from(creatorShowcaseDraftMedia).where(inArray(creatorShowcaseDraftMedia.showcaseId, showcaseIds)).orderBy(asc(creatorShowcaseDraftMedia.id));
  return { pages, drafts, handles, showcases, media, outbox, idempotency };
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

function errorChainText(error: unknown): string {
  const messages: string[] = [];
  let current = error;
  while (current && typeof current === "object") {
    const candidate = current as { message?: unknown; cause?: unknown };
    if (typeof candidate.message === "string") messages.push(candidate.message);
    current = candidate.cause;
  }
  return messages.join("\n");
}

async function expectCatalogFailureWithoutMutation(input: Readonly<{
  scope: AuthoritativeStateScope;
  code: CatalogServiceError["code"];
  invoke: () => Promise<unknown>;
  forbiddenValues?: readonly string[];
  label?: string;
}>) {
  const before = await authoritativeState(input.scope);
  const error = await rejectionOf(input.invoke());
  expect(error, `${input.label ?? input.code} error type`).toBeInstanceOf(CatalogServiceError);
  expect(error, `${input.label ?? input.code} error code`).toMatchObject({ code: input.code });
  for (const forbidden of input.forbiddenValues ?? []) expect(JSON.stringify(error), `${input.label ?? input.code} error leakage`).not.toContain(forbidden);
  expect(await authoritativeState(input.scope), `${input.label ?? input.code} authoritative state`).toEqual(before);
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

  test("rejects same-key different-body upsert, remove, and reorder without changing authoritative state", async () => {
    // Break caught: an idempotency conflict is checked after a catalog write or leaves a replacement command record/event behind.
    const userId = await approvedCreator("idempotency-conflicts");
    const catalog = service();
    const page = await catalog.initialize({ userId, requestId: "request-conflicts-initialize" });
    const scope = { pageIds: [page.pageId], actorUserIds: [userId] } as const;
    const firstUpsert = {
      actor: actor(userId), pageId: page.pageId, expectedVersion: 1, idempotencyKey: "conflict-upsert-key", requestId: "request-conflict-upsert",
      showcase: { position: 0, title: "First", description: "", discipline: "other", contentLabel: "general_audience", externalUrl: null, media: [] },
    } as const;
    await expect(catalog.upsertShowcase(firstUpsert)).resolves.toEqual({ pageId: page.pageId, draftVersion: 2 });
    const firstId = (await catalog.getWorkspace({ actorUserId: userId, pageId: page.pageId })).showcases[0]!.id;
    await expectCatalogFailureWithoutMutation({
      scope,
      code: "IDEMPOTENCY_CONFLICT",
      label: "upsert same-key different-body",
      invoke: () => catalog.upsertShowcase({ ...firstUpsert, showcase: { ...firstUpsert.showcase, title: "Different" } }),
    });

    await catalog.upsertShowcase({
      actor: actor(userId), pageId: page.pageId, expectedVersion: 2, idempotencyKey: "conflict-second-create", requestId: "request-conflict-second-create",
      showcase: { position: 1, title: "Second", description: "", discipline: "other", contentLabel: "general_audience", externalUrl: null, media: [] },
    });
    const secondId = (await catalog.getWorkspace({ actorUserId: userId, pageId: page.pageId })).showcases.find((showcase) => showcase.title === "Second")!.id;
    const firstRemove = { actor: actor(userId), pageId: page.pageId, expectedVersion: 3, idempotencyKey: "conflict-remove-key", requestId: "request-conflict-remove", showcaseId: firstId } as const;
    await expect(catalog.removeShowcase(firstRemove)).resolves.toEqual({ pageId: page.pageId, draftVersion: 4 });
    await expectCatalogFailureWithoutMutation({
      scope,
      code: "IDEMPOTENCY_CONFLICT",
      label: "remove same-key different-body",
      invoke: () => catalog.removeShowcase({ ...firstRemove, showcaseId: secondId }),
    });

    await catalog.upsertShowcase({
      actor: actor(userId), pageId: page.pageId, expectedVersion: 4, idempotencyKey: "conflict-third-create", requestId: "request-conflict-third-create",
      showcase: { position: 0, title: "Third", description: "", discipline: "other", contentLabel: "general_audience", externalUrl: null, media: [] },
    });
    const thirdId = (await catalog.getWorkspace({ actorUserId: userId, pageId: page.pageId })).showcases.find((showcase) => showcase.title === "Third")!.id;
    const firstReorder = { actor: actor(userId), pageId: page.pageId, expectedVersion: 5, idempotencyKey: "conflict-reorder-key", requestId: "request-conflict-reorder", showcaseIds: [secondId, thirdId] } as const;
    await expect(catalog.reorderShowcases(firstReorder)).resolves.toEqual({ pageId: page.pageId, draftVersion: 6 });
    await expectCatalogFailureWithoutMutation({
      scope,
      code: "IDEMPOTENCY_CONFLICT",
      label: "reorder same-key different-body",
      invoke: () => catalog.reorderShowcases({ ...firstReorder, showcaseIds: [thirdId, secondId] }),
    });
  });

  test("rejects foreign draft, handle, showcase update/remove, and reorder probes without leaking or mutating either page", async () => {
    // Break caught: a foreign command reveals ownership or changes either aggregate/domain/outbox/idempotency state before rejection.
    const targetUserId = await approvedCreator("foreign-target");
    const actorUserId = await approvedCreator("foreign-actor");
    const catalog = service();
    const targetPage = await catalog.initialize({ userId: targetUserId, requestId: "request-foreign-target-initialize" });
    const actorPage = await catalog.initialize({ userId: actorUserId, requestId: "request-foreign-actor-initialize" });
    await catalog.upsertShowcase({
      actor: actor(targetUserId), pageId: targetPage.pageId, expectedVersion: 1, idempotencyKey: "foreign-target-create", requestId: "request-foreign-target-create",
      showcase: { position: 0, title: "Target", description: "", discipline: "other", contentLabel: "general_audience", externalUrl: null, media: [] },
    });
    await catalog.upsertShowcase({
      actor: actor(actorUserId), pageId: actorPage.pageId, expectedVersion: 1, idempotencyKey: "foreign-actor-create", requestId: "request-foreign-actor-create",
      showcase: { position: 0, title: "Actor", description: "", discipline: "other", contentLabel: "general_audience", externalUrl: null, media: [] },
    });
    const targetShowcaseId = (await catalog.getWorkspace({ actorUserId: targetUserId, pageId: targetPage.pageId })).showcases[0]!.id;
    const actorShowcaseId = (await catalog.getWorkspace({ actorUserId, pageId: actorPage.pageId })).showcases[0]!.id;
    const scope = { pageIds: [targetPage.pageId, actorPage.pageId], actorUserIds: [targetUserId, actorUserId] } as const;
    const forbiddenValues = [targetUserId, actorUserId, targetPage.pageId, actorPage.pageId, targetShowcaseId, actorShowcaseId];
    const probes: ReadonlyArray<Readonly<{ name: string; code: CatalogServiceError["code"]; invoke: () => Promise<unknown> }>> = [
      {
        name: "foreign save draft",
        code: "NOT_FOUND",
        invoke: () => catalog.saveDraft({ actor: actor(actorUserId), pageId: targetPage.pageId, expectedVersion: 2, idempotencyKey: "foreign-save-draft", requestId: "request-foreign-save-draft", draft: { displayName: "Actor", introduction: "Valid private edit", primaryDiscipline: "other", secondaryDisciplines: [], avatarAssetId: null, coverAssetId: null } }),
      },
      {
        name: "foreign claim handle",
        code: "NOT_FOUND",
        invoke: () => catalog.claimHandle({ actor: actor(actorUserId), pageId: targetPage.pageId, expectedVersion: 2, idempotencyKey: "foreign-claim-handle", requestId: "request-foreign-claim-handle", handle: "foreign-safe-handle" }),
      },
      {
        name: "foreign existing-showcase update",
        code: "NOT_FOUND",
        invoke: () => catalog.upsertShowcase({ actor: actor(actorUserId), pageId: actorPage.pageId, expectedVersion: 2, idempotencyKey: "foreign-upsert-existing", requestId: "request-foreign-upsert-existing", showcase: { id: targetShowcaseId, position: 1, title: "Valid update", description: "", discipline: "other", contentLabel: "general_audience", externalUrl: null, media: [] } }),
      },
      {
        name: "foreign showcase remove",
        code: "NOT_FOUND",
        invoke: () => catalog.removeShowcase({ actor: actor(actorUserId), pageId: actorPage.pageId, expectedVersion: 2, idempotencyKey: "foreign-remove-existing", requestId: "request-foreign-remove-existing", showcaseId: targetShowcaseId }),
      },
      {
        name: "foreign showcase reorder",
        code: "POLICY_VIOLATION",
        invoke: () => catalog.reorderShowcases({ actor: actor(actorUserId), pageId: actorPage.pageId, expectedVersion: 2, idempotencyKey: "foreign-reorder-existing", requestId: "request-foreign-reorder-existing", showcaseIds: [targetShowcaseId] }),
      },
    ];
    for (const probe of probes) await expectCatalogFailureWithoutMutation({ scope, code: probe.code, invoke: probe.invoke, forbiddenValues, label: probe.name });
  });

  test("rejects one invalid showcase field at a time, including occupied positions, without partial state", async () => {
    // Break caught: any individual policy/identifier failure is accepted, leaks a driver error, or leaves aggregate/idempotency side effects.
    const userId = await approvedCreator("showcase-invalid");
    const foreignUserId = await approvedCreator("showcase-invalid-foreign");
    const catalog = service();
    const page = await catalog.initialize({ userId, requestId: "request-showcase-invalid-initialize" });
    const foreignPage = await catalog.initialize({ userId: foreignUserId, requestId: "request-showcase-invalid-foreign-initialize" });
    const validPendingAssetId = randomUUID();
    const created = await catalog.upsertShowcase({
      actor: actor(userId), pageId: page.pageId, expectedVersion: 1, idempotencyKey: "showcase-valid-pending", requestId: "request-showcase-valid-pending",
      showcase: { position: 0, title: "Café", description: "", discipline: "illustration", contentLabel: "general_audience", externalUrl: "https://example.test/work", media: [{ assetId: validPendingAssetId, alternativeText: "Cafe\u0301 work" }] },
    });
    await catalog.upsertShowcase({
      actor: actor(foreignUserId), pageId: foreignPage.pageId, expectedVersion: 1, idempotencyKey: "showcase-foreign-valid", requestId: "request-showcase-foreign-valid",
      showcase: { position: 0, title: "Foreign", description: "", discipline: "other", contentLabel: "general_audience", externalUrl: null, media: [] },
    });
    const workspace = await catalog.getWorkspace({ actorUserId: userId, pageId: page.pageId });
    const existingId = workspace.showcases[0]!.id;
    const foreignShowcaseId = (await catalog.getWorkspace({ actorUserId: foreignUserId, pageId: foreignPage.pageId })).showcases[0]!.id;
    expect(workspace.showcases[0]).toMatchObject({
      title: "Café",
      externalUrl: "https://example.test/work",
      media: [{ assetId: validPendingAssetId, alternativeText: "Café work" }],
    });

    const scope = { pageIds: [page.pageId, foreignPage.pageId], actorUserIds: [userId, foreignUserId] } as const;
    type ShowcaseProbeInput = Readonly<{
      id?: string;
      position: unknown;
      title: unknown;
      description: unknown;
      discipline: unknown;
      contentLabel: unknown;
      externalUrl: unknown;
      media: readonly Readonly<{ assetId: unknown; alternativeText: unknown }>[];
    }>;
    const validShowcase: ShowcaseProbeInput = { position: 1, title: "Valid", description: "", discipline: "other", contentLabel: "general_audience", externalUrl: null, media: [] };
    const upsert = (index: number, showcase: ShowcaseProbeInput) => catalog.upsertShowcase({
      actor: actor(userId), pageId: page.pageId, expectedVersion: created.draftVersion, idempotencyKey: `invalid-showcase-${index}`, requestId: `request-invalid-showcase-${index}`, showcase,
    });
    const probes: ReadonlyArray<Readonly<{ name: string; invoke: () => Promise<unknown> }>> = [
      { name: "position outside 0-11", invoke: () => upsert(1, { ...validShowcase, position: 12 }) },
      { name: "occupied active position", invoke: () => upsert(2, { ...validShowcase, position: 0 }) },
      { name: "invalid discipline", invoke: () => upsert(3, { ...validShowcase, discipline: "music" }) },
      { name: "non-general content label", invoke: () => upsert(4, { ...validShowcase, contentLabel: "age_restricted" }) },
      { name: "HTTP destination", invoke: () => upsert(5, { ...validShowcase, externalUrl: "http://example.test/work" }) },
      { name: "malformed HTTPS destination", invoke: () => upsert(6, { ...validShowcase, externalUrl: "https://" }) },
      { name: "five media", invoke: () => upsert(7, { ...validShowcase, media: Array.from({ length: 5 }, () => ({ assetId: randomUUID(), alternativeText: "Image" })) }) },
      { name: "empty alternative text", invoke: () => upsert(8, { ...validShowcase, media: [{ assetId: randomUUID(), alternativeText: "" }] }) },
      { name: "301 astral-code-point alternative text", invoke: () => upsert(9, { ...validShowcase, media: [{ assetId: randomUUID(), alternativeText: "\u{1F3A8}".repeat(301) }] }) },
      { name: "markup alternative text", invoke: () => upsert(10, { ...validShowcase, media: [{ assetId: randomUUID(), alternativeText: "<image>" }] }) },
      { name: "control alternative text", invoke: () => upsert(11, { ...validShowcase, media: [{ assetId: randomUUID(), alternativeText: "image\u0000" }] }) },
      { name: "bidi alternative text", invoke: () => upsert(12, { ...validShowcase, media: [{ assetId: randomUUID(), alternativeText: "image\u202E" }] }) },
      { name: "invalid existing-showcase update", invoke: () => upsert(13, { ...validShowcase, id: existingId, position: 0, title: "<unsafe>" }) },
      { name: "malformed workspace page ID", invoke: () => catalog.getWorkspace({ actorUserId: userId, pageId: "not-a-uuid" }) },
      { name: "malformed draft asset ID", invoke: () => catalog.saveDraft({ actor: actor(userId), pageId: page.pageId, expectedVersion: created.draftVersion, idempotencyKey: "invalid-draft-asset", requestId: "request-invalid-draft-asset", draft: { displayName: "Artist", introduction: "Intro", primaryDiscipline: "other", secondaryDisciplines: [], avatarAssetId: "not-a-uuid", coverAssetId: null } }) },
      { name: "malformed showcase media ID", invoke: () => upsert(16, { ...validShowcase, media: [{ assetId: "not-a-uuid", alternativeText: "Image" }] }) },
      { name: "malformed existing showcase ID", invoke: () => upsert(17, { ...validShowcase, id: "not-a-uuid" }) },
      { name: "malformed remove ID", invoke: () => catalog.removeShowcase({ actor: actor(userId), pageId: page.pageId, expectedVersion: created.draftVersion, idempotencyKey: "invalid-remove-id", requestId: "request-invalid-remove-id", showcaseId: "not-a-uuid" }) },
      { name: "malformed reorder ID", invoke: () => catalog.reorderShowcases({ actor: actor(userId), pageId: page.pageId, expectedVersion: created.draftVersion, idempotencyKey: "invalid-reorder-id", requestId: "request-invalid-reorder-id", showcaseIds: ["not-a-uuid"] }) },
      { name: "duplicate reorder IDs", invoke: () => catalog.reorderShowcases({ actor: actor(userId), pageId: page.pageId, expectedVersion: created.draftVersion, idempotencyKey: "invalid-reorder-duplicates", requestId: "request-invalid-reorder-duplicates", showcaseIds: [existingId, existingId] }) },
      { name: "foreign-page reorder IDs", invoke: () => catalog.reorderShowcases({ actor: actor(userId), pageId: page.pageId, expectedVersion: created.draftVersion, idempotencyKey: "invalid-reorder-foreign", requestId: "request-invalid-reorder-foreign", showcaseIds: [foreignShowcaseId] }) },
    ];

    for (const probe of probes) await expectCatalogFailureWithoutMutation({ scope, code: "POLICY_VIOLATION", invoke: probe.invoke, label: probe.name });
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
    await expect(service("suspended").getWorkspace({ actorUserId: userId, pageId: page.pageId })).resolves.toMatchObject({
      pageId: page.pageId,
      capabilityState: "suspended",
      enforcement: { pageHeld: false, heldShowcaseIds: [] },
    });
    await expect(service("suspended").saveDraft({ actor: actor(userId), pageId: page.pageId, expectedVersion: 1, idempotencyKey: "suspended-key-0001", requestId: "request-suspended-draft", draft: { displayName: "Remediation", introduction: "Private changes", primaryDiscipline: "other", secondaryDisciplines: [], avatarAssetId: null, coverAssetId: null } })).resolves.toEqual({ pageId: page.pageId, draftVersion: 2 });
    await expect(service("suspended").claimHandle({ actor: actor(userId), pageId: page.pageId, expectedVersion: 2, idempotencyKey: "suspended-key-0002", requestId: "request-suspended-handle", handle: "blocked-handle" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("accepts owned in-flight draft media but rejects a failed new reference", async () => {
    const pendingUserId = await approvedCreator("pending-media");
    const pending = service();
    const pendingPage = await pending.initialize({ userId: pendingUserId, requestId: "request-pending-media-init" });
    const pendingAssetId = randomUUID();
    await expect(pending.saveDraft({
      actor: actor(pendingUserId), pageId: pendingPage.pageId, expectedVersion: 1, idempotencyKey: "pending-media-save", requestId: "request-pending-media-save",
      draft: { displayName: "Pending", introduction: "Pending media", primaryDiscipline: "other", secondaryDisciplines: [], avatarAssetId: pendingAssetId, coverAssetId: null },
    })).resolves.toEqual({ pageId: pendingPage.pageId, draftVersion: 2 });
    await expect(pending.getWorkspace({ actorUserId: pendingUserId, pageId: pendingPage.pageId })).resolves.toMatchObject({ media: [{ assetId: pendingAssetId, state: "pending" }] });

    const failedUserId = await approvedCreator("failed-media");
    const failed = service("active", "general_audience", "failed");
    const failedPage = await failed.initialize({ userId: failedUserId, requestId: "request-failed-media-init" });
    await expect(failed.saveDraft({
      actor: actor(failedUserId), pageId: failedPage.pageId, expectedVersion: 1, idempotencyKey: "failed-media-save", requestId: "request-failed-media-save",
      draft: { displayName: "Failed", introduction: "Failed media", primaryDiscipline: "other", secondaryDisciplines: [], avatarAssetId: randomUUID(), coverAssetId: null },
    })).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
  });

  test("disabled mode rejects every fresh catalog mutation without authoritative drift", async () => {
    const userId = await approvedCreator("disabled-all");
    const enabled = service();
    const page = await enabled.initialize({ userId, requestId: "request-disabled-init" });
    const disabled = service("active", "disabled");
    const replayCommand = { actor: actor(userId), pageId: page.pageId, expectedVersion: 1, idempotencyKey: "disabled-replay-01", requestId: "request-disabled-replay", draft: { displayName: "Replay", introduction: "Replay intro", primaryDiscipline: "other", secondaryDisciplines: [], avatarAssetId: null, coverAssetId: null } } as const;
    const replayResult = await enabled.saveDraft(replayCommand);
    await expect(disabled.saveDraft(replayCommand)).resolves.toEqual(replayResult);
    const commands = [
      () => disabled.saveDraft({ actor: actor(userId), pageId: page.pageId, expectedVersion: 1, idempotencyKey: "disabled-save-01", requestId: "request-disabled-save", draft: { displayName: "Artist", introduction: "Intro", primaryDiscipline: "other", secondaryDisciplines: [], avatarAssetId: null, coverAssetId: null } }),
      () => disabled.claimHandle({ actor: actor(userId), pageId: page.pageId, expectedVersion: 1, idempotencyKey: "disabled-claim-01", requestId: "request-disabled-claim", handle: "disabled-claim" }),
      () => disabled.renameHandle({ actor: actor(userId), pageId: page.pageId, expectedVersion: 1, idempotencyKey: "disabled-rename-01", requestId: "request-disabled-rename", handle: "disabled-rename" }),
      () => disabled.upsertShowcase({ actor: actor(userId), pageId: page.pageId, expectedVersion: 1, idempotencyKey: "disabled-upsert-01", requestId: "request-disabled-upsert", showcase: { position: 0, title: "Title", description: "", discipline: "other", contentLabel: "general_audience", externalUrl: null, media: [] } }),
      () => disabled.removeShowcase({ actor: actor(userId), pageId: page.pageId, expectedVersion: 1, idempotencyKey: "disabled-remove-01", requestId: "request-disabled-remove", showcaseId: randomUUID() }),
      () => disabled.reorderShowcases({ actor: actor(userId), pageId: page.pageId, expectedVersion: 1, idempotencyKey: "disabled-reorder-01", requestId: "request-disabled-reorder", showcaseIds: [] }),
      () => disabled.publish({ actor: actor(userId), pageId: page.pageId, expectedVersion: 1, idempotencyKey: "disabled-publish-01", requestId: "request-disabled-publish" }),
      () => disabled.unpublish({ actor: actor(userId), pageId: page.pageId, expectedVersion: 1, idempotencyKey: "disabled-unpublish-01", requestId: "request-disabled-unpublish" }),
    ];
    const before = await authoritativeState({ pageIds: [page.pageId], actorUserIds: [userId] });
    for (const command of commands) await expect(command()).rejects.toMatchObject({ code: "PUBLISHING_DISABLED" });
    expect(await authoritativeState({ pageIds: [page.pageId], actorUserIds: [userId] })).toEqual(before);

    const newUserId = await approvedCreator("disabled-lazy");
    const beforeNew = await authoritativeState({ pageIds: [], actorUserIds: [newUserId] });
    await expect(disabled.initialize({ userId: newUserId, requestId: "request-disabled-lazy" })).rejects.toMatchObject({ code: "PUBLISHING_DISABLED" });
    expect(await authoritativeState({ pageIds: [], actorUserIds: [newUserId] })).toEqual(beforeNew);
    await expect(disabled.getWorkspace({ actorUserId: userId, pageId: page.pageId })).resolves.toMatchObject({ pageId: page.pageId });
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
    expect(Object.fromEntries(events.map((event) => [event.eventType, event.payload]))).toEqual({
      "creator.page_initialized.v1": { pageId: page.pageId, version: 1, correlationId: "request-outbox-initialize", actorUserId: userId },
      "creator.handle_claimed.v1": { pageId: page.pageId, version: 2, correlationId: "request-outbox-claim", actorUserId: userId },
    });
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
    async function assertCommand(name: string, eventType: string, version: number, requestId: string, invoke: () => Promise<{ pageId: string; draftVersion: number }>) {
      const before = await db.select({ id: systemOutbox.id, eventType: systemOutbox.eventType, eventVersion: systemOutbox.eventVersion, aggregateType: systemOutbox.aggregateType, aggregateId: systemOutbox.aggregateId, payload: systemOutbox.payload }).from(systemOutbox).where(eq(systemOutbox.aggregateId, page.pageId));
      const beforeEventIds = new Set(before.map((event) => event.id));
      const first = await invoke();
      expect(first, `${name} first result`).toEqual({ pageId: page.pageId, draftVersion: version });
      expect((await db.select({ version: creatorPages.draftVersion }).from(creatorPages).where(eq(creatorPages.id, page.pageId)))[0]?.version, `${name} page version`).toBe(version);
      const after = await db.select({ id: systemOutbox.id, eventType: systemOutbox.eventType, eventVersion: systemOutbox.eventVersion, aggregateType: systemOutbox.aggregateType, aggregateId: systemOutbox.aggregateId, payload: systemOutbox.payload }).from(systemOutbox).where(eq(systemOutbox.aggregateId, page.pageId));
      expect(after).toHaveLength(before.length + 1);
      const newEvents = after.filter((event) => !beforeEventIds.has(event.id));
      expect(newEvents, `${name} new event`).toHaveLength(1);
      const newEvent = newEvents[0]!;
      expect({
        eventType: newEvent.eventType,
        eventVersion: newEvent.eventVersion,
        aggregateType: newEvent.aggregateType,
        aggregateId: newEvent.aggregateId,
        payload: newEvent.payload,
      }).toEqual({
        eventType,
        eventVersion: 1,
        aggregateType: "creator_page",
        aggregateId: page.pageId,
        payload: { pageId: page.pageId, version, correlationId: requestId, actorUserId: userId },
      });
      const replay = await invoke();
      expect(replay, `${name} replay result`).toEqual({ pageId: page.pageId, draftVersion: version });
      expect(replay, `${name} replay matches first`).toEqual(first);
      expect((await db.select({ version: creatorPages.draftVersion }).from(creatorPages).where(eq(creatorPages.id, page.pageId)))[0]?.version, `${name} replay page version`).toBe(version);
      const afterReplay = await db.select({ id: systemOutbox.id }).from(systemOutbox).where(eq(systemOutbox.aggregateId, page.pageId));
      expect(afterReplay, `${name} replay event count`).toHaveLength(after.length);
      expect(new Set(afterReplay.map((event) => event.id)), `${name} replay event IDs`).toEqual(new Set(after.map((event) => event.id)));
    }
    const claim = { actor: actor(userId), pageId: page.pageId, expectedVersion: 1, idempotencyKey: "matrix-claim-0001", requestId: "matrix-claim", handle: "matrix-one" } as const;
    await assertCommand("claim", "creator.handle_claimed.v1", 2, claim.requestId, () => catalog.claimHandle(claim));
    const rename = { actor: actor(userId), pageId: page.pageId, expectedVersion: 2, idempotencyKey: "matrix-rename-0001", requestId: "matrix-rename", handle: "matrix-two" } as const;
    await assertCommand("rename", "creator.handle_renamed.v1", 3, rename.requestId, () => catalog.renameHandle(rename));
    const draft = { actor: actor(userId), pageId: page.pageId, expectedVersion: 3, idempotencyKey: "matrix-draft-0001", requestId: "matrix-draft", draft: { displayName: "Matrix Artist", introduction: "Matrix intro", primaryDiscipline: "other", secondaryDisciplines: [], avatarAssetId: null, coverAssetId: null } } as const;
    await assertCommand("save draft", "creator.page_draft_saved.v1", 4, draft.requestId, () => catalog.saveDraft(draft));
    const create = { actor: actor(userId), pageId: page.pageId, expectedVersion: 4, idempotencyKey: "matrix-create-0001", requestId: "matrix-create", showcase: { position: 0, title: "Before", description: "", discipline: "other", contentLabel: "general_audience", externalUrl: null, media: [{ assetId: randomUUID(), alternativeText: "Before image" }] } } as const;
    await assertCommand("showcase create", "creator.showcase_upserted.v1", 5, create.requestId, () => catalog.upsertShowcase(create));
    const showcaseId = (await catalog.getWorkspace({ actorUserId: userId, pageId: page.pageId })).showcases[0]!.id;
    const update = { actor: actor(userId), pageId: page.pageId, expectedVersion: 5, idempotencyKey: "matrix-update-0001", requestId: "matrix-update", showcase: { ...create.showcase, id: showcaseId, title: "After", media: [{ assetId: randomUUID(), alternativeText: "After image" }] } } as const;
    await assertCommand("showcase update", "creator.showcase_upserted.v1", 6, update.requestId, () => catalog.upsertShowcase(update));
    expect((await catalog.getWorkspace({ actorUserId: userId, pageId: page.pageId })).showcases[0]).toMatchObject({ id: showcaseId, title: "After", media: [{ alternativeText: "After image" }] });
    const second = { actor: actor(userId), pageId: page.pageId, expectedVersion: 6, idempotencyKey: "matrix-second-0001", requestId: "matrix-second", showcase: { ...create.showcase, position: 1, title: "Second", media: [] } } as const;
    await assertCommand("second create", "creator.showcase_upserted.v1", 7, second.requestId, () => catalog.upsertShowcase(second));
    const remove = { actor: actor(userId), pageId: page.pageId, expectedVersion: 7, idempotencyKey: "matrix-remove-0001", requestId: "matrix-remove", showcaseId } as const;
    await assertCommand("showcase remove", "creator.showcase_removed.v1", 8, remove.requestId, () => catalog.removeShowcase(remove));
    const remainingId = (await catalog.getWorkspace({ actorUserId: userId, pageId: page.pageId })).showcases[0]!.id;
    const reorder = { actor: actor(userId), pageId: page.pageId, expectedVersion: 8, idempotencyKey: "matrix-reorder-0001", requestId: "matrix-reorder", showcaseIds: [remainingId] } as const;
    await assertCommand("showcase reorder", "creator.showcase_reordered.v1", 9, reorder.requestId, () => catalog.reorderShowcases(reorder));
    const serialized = JSON.stringify(await db.select().from(systemOutbox).where(eq(systemOutbox.aggregateId, page.pageId)));
    for (const forbidden of ["session", "Matrix Artist", "Matrix intro", "assetId", "alternativeText", "portfolio", "application"]) expect(serialized).not.toContain(forbidden);
  });

  test("rejects an occupied active position without partial state", async () => {
    // Break caught: an occupied active position overwrites/replaces the existing showcase or advances command state.
    const userId = await approvedCreator("occupied-position"); const catalog = service(); const page = await catalog.initialize({ userId, requestId: "occupied-position-init" });
    await catalog.upsertShowcase({ actor: actor(userId), pageId: page.pageId, expectedVersion: 1, idempotencyKey: "occupied-position-first", requestId: "occupied-position-first", showcase: { position: 0, title: "First", description: "", discipline: "other", contentLabel: "general_audience", externalUrl: null, media: [] } });
    await expectCatalogFailureWithoutMutation({
      scope: { pageIds: [page.pageId], actorUserIds: [userId] },
      code: "POLICY_VIOLATION",
      invoke: () => catalog.upsertShowcase({ actor: actor(userId), pageId: page.pageId, expectedVersion: 2, idempotencyKey: "occupied-position-next", requestId: "occupied-position-next", showcase: { position: 0, title: "Second", description: "", discipline: "other", contentLabel: "general_audience", externalUrl: null, media: [] } }),
    });
  });

  test("enforces the 12-active-showcase database trigger independently and restores the transactional index DDL", async () => {
    // Break caught: removing the position collision reveals that the database count trigger permits a thirteenth active row.
    const userId = await approvedCreator("active-count-trigger"); const catalog = service(); const page = await catalog.initialize({ userId, requestId: "active-count-trigger-init" });
    let version = 1;
    for (let position = 0; position < 12; position += 1) {
      version = (await catalog.upsertShowcase({ actor: actor(userId), pageId: page.pageId, expectedVersion: version, idempotencyKey: `active-count-${position}`, requestId: `active-count-${position}`, showcase: { position, title: `Item ${position}`, description: "", discipline: "other", contentLabel: "general_audience", externalUrl: null, media: [] } })).draftVersion;
    }
    expect(version).toBe(13);

    const triggerFailure = await rejectionOf(db.transaction(async (tx) => {
      await tx.execute(sql.raw('drop index "creator_showcase_drafts_active_position_uidx"'));
      await tx.insert(creatorShowcaseDrafts).values({
        id: randomUUID(), pageId: page.pageId, position: 0, title: "Thirteenth", description: "", discipline: "other",
        contentLabel: "general_audience", externalUrl: null, removedAt: null, createdAt: at, updatedAt: at,
      });
    }));
    expect(postgresErrorCode(triggerFailure)).toBe("23514");
    expect(errorChainText(triggerFailure)).toContain("creator pages may have at most 12 active showcases");

    const activeRows = await db.select({ id: creatorShowcaseDrafts.id, position: creatorShowcaseDrafts.position }).from(creatorShowcaseDrafts).where(and(eq(creatorShowcaseDrafts.pageId, page.pageId), isNull(creatorShowcaseDrafts.removedAt))).orderBy(asc(creatorShowcaseDrafts.position));
    expect(activeRows).toHaveLength(12);
    expect(activeRows.map((row) => row.position)).toEqual(Array.from({ length: 12 }, (_, position) => position));
    const restoredIndex = await db.execute<{ indexname: string; indexdef: string }>(sql`
      select indexname, indexdef
      from pg_indexes
      where schemaname = current_schema()
        and tablename = 'creator_showcase_drafts'
        and indexname = 'creator_showcase_drafts_active_position_uidx'
    `);
    expect(restoredIndex).toHaveLength(1);
    expect(restoredIndex[0]?.indexdef).toContain("CREATE UNIQUE INDEX creator_showcase_drafts_active_position_uidx");
    expect(restoredIndex[0]?.indexdef).toContain("WHERE (removed_at IS NULL)");
    const duplicatePositionFailure = await rejectionOf(db.update(creatorShowcaseDrafts).set({ position: 0 }).where(eq(creatorShowcaseDrafts.id, activeRows[1]!.id)));
    expect(postgresErrorCode(duplicatePositionFailure)).toBe("23505");
    expect((await db.select({ position: creatorShowcaseDrafts.position }).from(creatorShowcaseDrafts).where(and(eq(creatorShowcaseDrafts.pageId, page.pageId), isNull(creatorShowcaseDrafts.removedAt))).orderBy(asc(creatorShowcaseDrafts.position))).map((row) => row.position)).toEqual(Array.from({ length: 12 }, (_, position) => position));
  });
});
