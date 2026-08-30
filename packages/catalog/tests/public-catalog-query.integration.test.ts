import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createDatabase,
  creatorDiscoveryProjections,
  creatorHandleClaims,
  creatorPages,
  identityUsers,
  publicContentReports,
  type PawketDatabase,
} from "@pawket/database";
import {
  createCatalogService,
  createPublicCatalogQuery,
  type CreatorSeed,
  type MediaReference,
  type ReadyMedia,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for catalog integration tests");

const schemaName = `public_catalog_query_${process.pid}_${Date.now()}`;
const migrationsDirectory = new URL("../../database/migrations/", import.meta.url);
const at = new Date("2026-08-30T05:00:00.000Z");
const commandFingerprintKey = new Uint8Array(32).fill(37);
let db: PawketDatabase;
let closeDatabase: (() => Promise<void>) | undefined;

async function migrate(filename: string): Promise<void> {
  const migration = await readFile(new URL(filename, migrationsDirectory), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) if (statement.trim()) await db.execute(sql.raw(statement));
}

const capabilities = new Map<string, CreatorSeed["capabilityState"] | null>();
const media = new Map<string, ReadyMedia>();
let pageHoldIds = new Set<string>();
let showcaseHoldIds = new Set<string>();
let publishingMode: "disabled" | "general_audience" = "general_audience";
let mediaResolveCalls = 0;
let mediaMapMode: "exact" | "get_only" | "missing" | "extra" | "wrong_key" | "wrong_asset" | "wrong_owner" | "wrong_purpose" | "masked_extra" | "subclass" | "proxy" | "outer_get_only" | "outer_missing" | "outer_extra" | "outer_masked_extra" | "outer_subclass" | "outer_proxy" = "exact";
let identityBatchMode: "exact" | "missing" | "extra" | "masked_extra" | "subclass" | "proxy" = "exact";
let identityValueMode: "exact" | "extra" | "prototype" | "accessor" | "proxy" = "exact";
let visibilityBatchMode: "exact" | "missing" | "extra" | "masked_extra" | "subclass" | "proxy" = "exact";
let holdValueMode: "exact" | "extra" | "prototype" | "accessor" | "proxy" = "exact";
let holdSetMode: "exact" | "masked_extra" | "subclass" | "proxy" = "exact";
let mediaValueMode: "exact" | "extra" | "prototype" | "accessor" | "proxy" | "derivative_extra" | "derivative_prototype" | "derivative_accessor" = "exact";
let boundaryGetterCalls = 0;
const providerCalls = { identitySingle: 0, identityBatch: 0, visibilitySingle: 0, visibilityBatch: 0, mediaSingle: 0, mediaBatch: 0 };
function resetProviderCalls() { for (const key of Object.keys(providerCalls) as (keyof typeof providerCalls)[]) providerCalls[key] = 0; }
function mutateAssetMap(result: Map<string, ReadyMedia>): unknown {
  const [firstKey, firstValue] = result.entries().next().value ?? [];
  if (firstKey && firstValue && mediaValueMode !== "exact") {
    let mutated: ReadyMedia;
    if (mediaValueMode === "extra") mutated = { ...firstValue, unexpected: true } as unknown as ReadyMedia;
    else if (mediaValueMode === "prototype") mutated = Object.assign(Object.create({ ownerUserId: firstValue.ownerUserId }), { assetId: firstValue.assetId, purpose: firstValue.purpose, derivatives: firstValue.derivatives }) as ReadyMedia;
    else if (mediaValueMode === "accessor") {
      const value = { ...firstValue } as Record<string, unknown>;
      Object.defineProperty(value, "ownerUserId", { enumerable: true, get() { boundaryGetterCalls += 1; return firstValue.ownerUserId; } });
      mutated = value as ReadyMedia;
    } else if (mediaValueMode === "proxy") mutated = new Proxy(firstValue, {});
    else {
      const thumb = mediaValueMode === "derivative_extra"
        ? { ...firstValue.derivatives.thumb, unexpected: true }
        : mediaValueMode === "derivative_prototype"
          ? Object.assign(Object.create({ width: firstValue.derivatives.thumb.width }), { derivativeId: firstValue.derivatives.thumb.derivativeId, height: firstValue.derivatives.thumb.height })
          : (() => {
              const value = { ...firstValue.derivatives.thumb } as Record<string, unknown>;
              Object.defineProperty(value, "width", { enumerable: true, get() { boundaryGetterCalls += 1; return firstValue.derivatives.thumb.width; } });
              return value;
            })();
      mutated = { ...firstValue, derivatives: { ...firstValue.derivatives, thumb } } as ReadyMedia;
    }
    result.set(firstKey, mutated);
  }
  if (mediaMapMode === "get_only") return { get: result.get.bind(result) };
  if (mediaMapMode === "missing" && firstKey) result.delete(firstKey);
  if (mediaMapMode === "extra" && firstValue) result.set(randomUUID(), firstValue);
  if (mediaMapMode === "wrong_key" && firstKey && firstValue) { result.delete(firstKey); result.set(randomUUID(), firstValue); }
  if (mediaMapMode === "wrong_asset" && firstKey && firstValue) result.set(firstKey, { ...firstValue, assetId: randomUUID() });
  if (mediaMapMode === "wrong_owner" && firstKey && firstValue) result.set(firstKey, { ...firstValue, ownerUserId: `foreign-${randomUUID()}` });
  if (mediaMapMode === "wrong_purpose" && firstKey && firstValue) result.set(firstKey, { ...firstValue, purpose: firstValue.purpose === "avatar" ? "cover" : "avatar" });
  if (mediaMapMode === "masked_extra" && firstValue) {
    const visibleKeys = [...result.keys()];
    result.set(randomUUID(), firstValue);
    Object.defineProperty(result, "size", { get() { boundaryGetterCalls += 1; return visibleKeys.length; } });
    Object.defineProperty(result, "keys", { get() { boundaryGetterCalls += 1; return () => visibleKeys.values(); } });
    Object.defineProperty(result, "get", { get() { boundaryGetterCalls += 1; return Map.prototype.get.bind(result); } });
  }
  if (mediaMapMode === "subclass") return new (class extends Map<string, ReadyMedia> {})(result);
  if (mediaMapMode === "proxy") return new Proxy(result, {});
  return result;
}

function mutateSeed(seed: CreatorSeed): CreatorSeed {
  if (identityValueMode === "extra") return { ...seed, unexpected: true } as unknown as CreatorSeed;
  if (identityValueMode === "prototype") return Object.assign(Object.create({ capabilityState: seed.capabilityState }), { userId: seed.userId, capabilityVersion: seed.capabilityVersion, approvedRevisionId: seed.approvedRevisionId, displayName: seed.displayName, introduction: seed.introduction }) as CreatorSeed;
  if (identityValueMode === "accessor") {
    const value = { ...seed } as Record<string, unknown>;
    Object.defineProperty(value, "capabilityState", { enumerable: true, get() { boundaryGetterCalls += 1; return seed.capabilityState; } });
    return value as CreatorSeed;
  }
  if (identityValueMode === "proxy") return new Proxy(seed, {});
  return seed;
}

function spoofMap<K, V>(result: Map<K, V>, mode: "exact" | "missing" | "extra" | "masked_extra" | "subclass" | "proxy", extraKey: K, extraValue: V): unknown {
  if (mode === "missing") result.delete(result.keys().next().value as K);
  if (mode === "extra") result.set(extraKey, extraValue);
  if (mode === "masked_extra") {
    const visibleKeys = [...result.keys()];
    result.set(extraKey, extraValue);
    Object.defineProperty(result, "size", { get() { boundaryGetterCalls += 1; return visibleKeys.length; } });
    Object.defineProperty(result, "keys", { get() { boundaryGetterCalls += 1; return () => visibleKeys.values(); } });
    Object.defineProperty(result, "get", { get() { boundaryGetterCalls += 1; return Map.prototype.get.bind(result); } });
  }
  if (mode === "subclass") return new (class extends Map<K, V> {})(result);
  if (mode === "proxy") return new Proxy(result, {});
  return result;
}

const creatorSeeds = {
  async getCreatorSeed(_database: unknown, userId: string): Promise<CreatorSeed | null> {
    providerCalls.identitySingle += 1;
    const capabilityState = capabilities.get(userId);
    if (!capabilityState) return null;
    return mutateSeed({ userId, capabilityState, capabilityVersion: 1, approvedRevisionId: randomUUID(), displayName: "Seed", introduction: "Seed intro" });
  },
  async getCreatorSeeds(_database: unknown, userIds: readonly string[]) {
    providerCalls.identityBatch += 1;
    const result = new Map(userIds.map((userId) => {
      const capabilityState = capabilities.get(userId);
      return [userId, capabilityState ? mutateSeed({ userId, capabilityState, capabilityVersion: 1, approvedRevisionId: randomUUID(), displayName: "Seed", introduction: "Seed intro" }) : null] as const;
    }));
    return spoofMap(result, identityBatchMode, `foreign-${randomUUID()}`, null) as ReadonlyMap<string, CreatorSeed | null>;
  },
};
const mediaCatalog = {
  async resolveReadyAssets(_database: unknown, ownerUserId: string, references: readonly MediaReference[]) {
    mediaResolveCalls += 1;
    providerCalls.mediaSingle += 1;
    return mutateAssetMap(new Map(references.flatMap((reference) => {
      const asset = media.get(reference.assetId);
      return asset?.ownerUserId === ownerUserId && asset.purpose === reference.purpose ? [[asset.assetId, asset] as const] : [];
    })) as Map<string, ReadyMedia>) as ReadonlyMap<string, ReadyMedia>;
  },
  async resolveReadyAssetsBatch(_database: unknown, requests: readonly { ownerUserId: string; references: readonly MediaReference[] }[]) {
    providerCalls.mediaBatch += 1;
    const result = new Map(requests.map((request) => [request.ownerUserId, mutateAssetMap(new Map(request.references.flatMap((reference) => {
      const asset = media.get(reference.assetId);
      return asset?.ownerUserId === request.ownerUserId && asset.purpose === reference.purpose ? [[asset.assetId, asset] as const] : [];
    })) as Map<string, ReadyMedia>)] as const));
    if (mediaMapMode === "outer_get_only") return { get: result.get.bind(result) } as unknown as ReadonlyMap<string, ReadonlyMap<string, ReadyMedia>>;
    if (mediaMapMode === "outer_missing") result.delete(requests[0]?.ownerUserId ?? "");
    if (mediaMapMode === "outer_extra") result.set(`foreign-${randomUUID()}`, new Map());
    if (mediaMapMode === "outer_masked_extra") return spoofMap(result, "masked_extra", `foreign-${randomUUID()}`, new Map()) as ReadonlyMap<string, ReadonlyMap<string, ReadyMedia>>;
    if (mediaMapMode === "outer_subclass") return spoofMap(result, "subclass", `foreign-${randomUUID()}`, new Map()) as ReadonlyMap<string, ReadonlyMap<string, ReadyMedia>>;
    if (mediaMapMode === "outer_proxy") return spoofMap(result, "proxy", `foreign-${randomUUID()}`, new Map()) as ReadonlyMap<string, ReadonlyMap<string, ReadyMedia>>;
    return result as ReadonlyMap<string, ReadonlyMap<string, ReadyMedia>>;
  },
};
const visibility = {
  async readHolds(_database: unknown, pageId: string, _revisionId: string, showcaseIds: readonly string[]) {
    providerCalls.visibilitySingle += 1;
    return { pageHeld: pageHoldIds.has(pageId), heldShowcaseIds: new Set(showcaseIds.filter((id) => showcaseHoldIds.has(id))) };
  },
  async readHoldsBatch(_database: unknown, requests: readonly { pageId: string; revisionId: string; showcaseIds: readonly string[] }[]) {
    providerCalls.visibilityBatch += 1;
    const result = new Map(requests.map((request) => {
      let heldShowcaseIds: Set<string> = new Set(request.showcaseIds.filter((id) => showcaseHoldIds.has(id)));
      if (holdSetMode === "masked_extra") {
        heldShowcaseIds.add(randomUUID());
        Object.defineProperty(heldShowcaseIds, Symbol.iterator, { get() { boundaryGetterCalls += 1; return () => new Set<string>().values(); } });
        Object.defineProperty(heldShowcaseIds, "has", { get() { boundaryGetterCalls += 1; return () => false; } });
      } else if (holdSetMode === "subclass") heldShowcaseIds = new (class extends Set<string> {})(heldShowcaseIds);
      else if (holdSetMode === "proxy") heldShowcaseIds = new Proxy(heldShowcaseIds, {});
      let snapshot: { pageHeld: boolean; heldShowcaseIds: ReadonlySet<string> } = { pageHeld: pageHoldIds.has(request.pageId), heldShowcaseIds };
      if (holdValueMode === "extra") snapshot = { ...snapshot, unexpected: true } as typeof snapshot;
      else if (holdValueMode === "prototype") snapshot = Object.assign(Object.create({ pageHeld: snapshot.pageHeld }), { heldShowcaseIds: snapshot.heldShowcaseIds }) as typeof snapshot;
      else if (holdValueMode === "accessor") {
        const pageHeld = snapshot.pageHeld;
        const value = { ...snapshot } as Record<string, unknown>;
        Object.defineProperty(value, "pageHeld", { enumerable: true, get() { boundaryGetterCalls += 1; return pageHeld; } });
        snapshot = value as typeof snapshot;
      } else if (holdValueMode === "proxy") snapshot = new Proxy(snapshot, {});
      return [request.pageId, snapshot] as const;
    }));
    return spoofMap(result, visibilityBatchMode, randomUUID(), { pageHeld: false, heldShowcaseIds: new Set<string>() }) as ReadonlyMap<string, { pageHeld: boolean; heldShowcaseIds: ReadonlySet<string> }>;
  },
};

function composition() {
  const common = { db, creatorSeeds, mediaCatalog, visibility, publishingMode } as const;
  return {
    service: createCatalogService({ ...common, commandFingerprintKey, now: () => at }),
    query: createPublicCatalogQuery(common),
  };
}

function actor(userId: string) { return { userId, sessionId: "session-query", primaryAuthenticatedAt: at }; }

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function readyMedia(ownerUserId: string, purpose: MediaReference["purpose"]): ReadyMedia {
  return {
    assetId: randomUUID(), ownerUserId, purpose,
    derivatives: {
      thumb: { derivativeId: randomUUID(), width: 384, height: 300 },
      display: { derivativeId: randomUUID(), width: 1280, height: 1000 },
      large: { derivativeId: randomUUID(), width: 2400, height: 1800 },
    },
  };
}

async function publishCreator(handle: string, options: { discipline?: "illustration" | "drawing"; showcases?: number } = {}) {
  const userId = `query-${handle}-${randomUUID()}`;
  capabilities.set(userId, "active");
  await db.insert(identityUsers).values({
    id: userId, name: handle, email: `${userId}@example.test`, canonicalEmail: `${userId}@example.test`,
    emailVerified: true, emailVerifiedAt: at, emailVerificationProvenance: "password_email_challenge", createdAt: at, updatedAt: at,
  });
  const { service } = composition();
  const initialized = await service.initialize({ userId, requestId: `initialize-${handle}` });
  let version = (await service.claimHandle({ actor: actor(userId), pageId: initialized.pageId, expectedVersion: 1, idempotencyKey: `claim-${handle}`, requestId: `claim-${handle}`, handle })).draftVersion;
  const avatar = readyMedia(userId, "avatar"); media.set(avatar.assetId, avatar);
  const cover = readyMedia(userId, "cover"); media.set(cover.assetId, cover);
  version = (await service.saveDraft({
    actor: actor(userId), pageId: initialized.pageId, expectedVersion: version, idempotencyKey: `draft-${handle}`, requestId: `draft-${handle}`,
    draft: { displayName: `Creator ${handle}`, introduction: `Introduction for ${handle}`, primaryDiscipline: options.discipline ?? "illustration", secondaryDisciplines: [], avatarAssetId: avatar.assetId, coverAssetId: cover.assetId },
  })).draftVersion;
  const showcaseIds: string[] = [];
  const showcaseAssets: ReadyMedia[] = [];
  for (let position = 0; position < (options.showcases ?? 1); position += 1) {
    const asset = readyMedia(userId, "showcase"); media.set(asset.assetId, asset);
    showcaseAssets.push(asset);
    version = (await service.upsertShowcase({
      actor: actor(userId), pageId: initialized.pageId, expectedVersion: version, idempotencyKey: `showcase-${handle}-${position}`, requestId: `showcase-${handle}-${position}`,
      showcase: { position, title: `${handle} work ${position}`, description: "Public work", discipline: options.discipline ?? "illustration", contentLabel: "general_audience", externalUrl: null, media: [{ assetId: asset.assetId, alternativeText: `${handle} image ${position}` }] },
    })).draftVersion;
    const workspace = await service.getWorkspace({ actorUserId: userId, pageId: initialized.pageId });
    showcaseIds.push(workspace.showcases[position]!.id);
  }
  const published = await service.publish({ actor: actor(userId), pageId: initialized.pageId, expectedVersion: version, idempotencyKey: `publish-${handle}`, requestId: `publish-${handle}` });
  return { userId, pageId: initialized.pageId, revisionId: published.revisionId, showcaseIds, showcaseAssets, avatar, cover, version };
}

beforeAll(async () => {
  const root = createDatabase(databaseUrl);
  await root.db.execute(sql.raw(`create schema "${schemaName}"`));
  await root.close();
  const connection = createDatabase(`${databaseUrl}?options=-csearch_path%3D${schemaName},public`);
  db = connection.db; closeDatabase = connection.close;
  for (const migration of (await readdir(migrationsDirectory)).filter((entry) => entry.endsWith(".sql")).sort()) await migrate(migration);
});

afterAll(async () => {
  await closeDatabase?.();
  const root = createDatabase(databaseUrl);
  await root.db.execute(sql.raw(`drop schema if exists "${schemaName}" cascade`));
  await root.close();
});

describe("effective public catalog query", () => {
  test("canonical, alias, hidden, suspended, and unknown resolution are bounded", async () => {
    // Break caught: resolver redirects an alias whose canonical page is not effectively visible, or reveals hidden state.
    pageHoldIds = new Set(); showcaseHoldIds = new Set(); publishingMode = "general_audience";
    const visible = await publishCreator(`artist-${randomUUID().slice(0, 6)}`);
    const hidden = await publishCreator(`hidden-${randomUUID().slice(0, 6)}`);
    const suspended = await publishCreator(`suspend-${randomUUID().slice(0, 6)}`);
    const [canonical] = await db.select().from(creatorHandleClaims).where(eq(creatorHandleClaims.pageId, visible.pageId));
    if (!canonical) throw new Error("Expected canonical handle");
    const replacement = `artist-new-${randomUUID().slice(0, 6)}`;
    await composition().service.renameHandle({ actor: actor(visible.userId), pageId: visible.pageId, expectedVersion: visible.version, idempotencyKey: `rename-${visible.pageId}`, requestId: `rename-${visible.pageId}`, handle: replacement });
    pageHoldIds.add(hidden.pageId);
    capabilities.set(suspended.userId, "suspended");
    const { query } = composition();
    expect(await query.resolvePublicCreator(replacement)).toMatchObject({ kind: "visible" });
    expect(await query.resolvePublicCreator(canonical.normalizedHandle)).toEqual({ kind: "redirect", canonicalHandle: replacement });
    const hiddenHandle = (await db.select().from(creatorHandleClaims).where(eq(creatorHandleClaims.pageId, hidden.pageId)))[0]!.normalizedHandle;
    const suspendedHandle = (await db.select().from(creatorHandleClaims).where(eq(creatorHandleClaims.pageId, suspended.pageId)))[0]!.normalizedHandle;
    expect(await query.resolvePublicCreator(hiddenHandle)).toEqual({ kind: "not_found" });
    expect(await query.resolvePublicCreator(suspendedHandle)).toEqual({ kind: "not_found" });
    expect(await query.resolvePublicCreator("unknown-name")).toEqual({ kind: "not_found" });
  });

  test("filters held showcases while a page hold hides the complete page", async () => {
    // Break caught: a showcase hold hides too much or leaks the held child/raw hold details.
    pageHoldIds = new Set(); showcaseHoldIds = new Set(); publishingMode = "general_audience";
    const creator = await publishCreator(`holds-${randomUUID().slice(0, 7)}`, { showcases: 2 });
    const handle = (await db.select().from(creatorHandleClaims).where(eq(creatorHandleClaims.pageId, creator.pageId)))[0]!.normalizedHandle;
    showcaseHoldIds.add(creator.showcaseIds[0]!);
    const { query } = composition();
    const result = await query.resolvePublicCreator(handle);
    expect(result).toMatchObject({ kind: "visible", page: { showcases: [{ sourceShowcaseId: creator.showcaseIds[1] }] } });
    expect(JSON.stringify(result)).not.toMatch(/held|holdReason|ownerNote/i);
    pageHoldIds.add(creator.pageId);
    expect(await query.resolvePublicCreator(handle)).toEqual({ kind: "not_found" });
  });

  test("fails closed for disabled mode, stale projection, missing media, and changed media authorization", async () => {
    // Break caught: effective visibility trusts a projection/head without rechecking current mode, revision, or ready media.
    pageHoldIds = new Set(); showcaseHoldIds = new Set(); publishingMode = "general_audience";
    const creator = await publishCreator(`failclosed-${randomUUID().slice(0, 5)}`);
    const handle = (await db.select().from(creatorHandleClaims).where(eq(creatorHandleClaims.pageId, creator.pageId)))[0]!.normalizedHandle;
    const { query } = composition();
    expect(await query.resolvePublicCreator(handle)).toMatchObject({ kind: "visible" });
    publishingMode = "disabled";
    expect(await composition().query.resolvePublicCreator(handle)).toEqual({ kind: "not_found" });
    publishingMode = "general_audience";
    const secondRevision = await composition().service.publish({ actor: actor(creator.userId), pageId: creator.pageId, expectedVersion: creator.version, idempotencyKey: `republish-${creator.pageId}`, requestId: `republish-${creator.pageId}` });
    await db.update(creatorPages).set({ publishedRevisionId: creator.revisionId }).where(eq(creatorPages.id, creator.pageId));
    expect(await query.resolvePublicCreator(handle)).toEqual({ kind: "not_found" });
    await db.update(creatorPages).set({ publishedRevisionId: secondRevision.revisionId }).where(eq(creatorPages.id, creator.pageId));
    media.set(creator.avatar.assetId, { ...creator.avatar, derivatives: { ...creator.avatar.derivatives, thumb: { ...creator.avatar.derivatives.thumb, derivativeId: randomUUID() } } });
    expect(await query.resolvePublicCreator(handle)).toEqual({ kind: "not_found" });
    media.delete(creator.avatar.assetId);
    expect(await query.resolvePublicCreator(handle)).toEqual({ kind: "not_found" });
  });

  test("directory order and cursor are stable, canonical-only, and limited to exactly 24", async () => {
    // Break caught: pagination repeats/skips pages, accepts arbitrary limits, or includes aliases/hidden creators.
    pageHoldIds = new Set(); showcaseHoldIds = new Set(); publishingMode = "general_audience";
    const prefix = `art${randomUUID().slice(0, 4)}`;
    for (let index = 0; index < 27; index += 1) await publishCreator(`${prefix}-${index.toString().padStart(2, "0")}`, { discipline: "illustration", showcases: 0 });
    const { query } = composition();
    const first = await query.listPublicCreators({ discipline: "illustration", handlePrefix: prefix, cursor: null, limit: 24 });
    expect(first.items.map((item) => item.canonicalHandle)).toEqual([...first.items.map((item) => item.canonicalHandle)].sort());
    expect(first.items).toHaveLength(24);
    const second = await query.listPublicCreators({ discipline: "illustration", handlePrefix: prefix, cursor: first.nextCursor, limit: 24 });
    expect(new Set([...first.items, ...second.items].map((item) => item.pageId)).size).toBe(first.items.length + second.items.length);
    expect([...first.items, ...second.items]).toHaveLength(27);
    await expect(query.listPublicCreators({ discipline: "illustration", handlePrefix: prefix, cursor: null, limit: 23 as 24 })).rejects.toMatchObject({ code: "INVALID_QUERY" });
    await expect(query.listPublicCreators({ discipline: "illustration", handlePrefix: prefix, cursor: "not-a-cursor", limit: 24 })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });

  test("directory caps each request at 96 candidates and advances across an all-held population", async () => {
    pageHoldIds = new Set(); showcaseHoldIds = new Set(); publishingMode = "general_audience";
    const prefix = `batch${randomUUID().slice(0, 4)}`;
    for (let index = 0; index < 100; index += 1) {
      const hidden = await publishCreator(`${prefix}-${index.toString().padStart(3, "0")}`, { showcases: 0 });
      pageHoldIds.add(hidden.pageId);
    }
    for (let index = 100; index < 126; index += 1) await publishCreator(`${prefix}-${index.toString().padStart(3, "0")}`, { showcases: 0 });
    const { query } = composition();
    resetProviderCalls();
    const first = await query.listPublicCreators({ discipline: null, handlePrefix: prefix, cursor: null, limit: 24 });
    expect(first.items).toEqual([]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(providerCalls).toMatchObject({ identitySingle: 0, visibilitySingle: 0, mediaSingle: 0, identityBatch: 2, visibilityBatch: 2, mediaBatch: 2 });
    resetProviderCalls();
    const second = await query.listPublicCreators({ discipline: null, handlePrefix: prefix, cursor: first.nextCursor, limit: 24 });
    expect(providerCalls).toMatchObject({ identitySingle: 0, visibilitySingle: 0, mediaSingle: 0, identityBatch: 1, visibilityBatch: 1, mediaBatch: 1 });
    resetProviderCalls();
    const third = await query.listPublicCreators({ discipline: null, handlePrefix: prefix, cursor: second.nextCursor, limit: 24 });
    expect(providerCalls).toMatchObject({ identitySingle: 0, visibilitySingle: 0, mediaSingle: 0, identityBatch: 1, visibilityBatch: 1, mediaBatch: 1 });
    expect(second.items).toHaveLength(24);
    expect(third.items).toHaveLength(2);
    expect(new Set([...second.items, ...third.items].map((item) => item.pageId)).size).toBe(26);
  }, 30_000);

  test("sitemap evaluates complete catalog in fixed provider batches without per-page calls", async () => {
    pageHoldIds = new Set(); showcaseHoldIds = new Set(); publishingMode = "general_audience";
    const enabled = await db.select({ pageId: creatorDiscoveryProjections.pageId }).from(creatorDiscoveryProjections).where(eq(creatorDiscoveryProjections.enabled, true));
    resetProviderCalls();
    await composition().query.listSitemapCreators();
    const expectedBatches = Math.ceil(enabled.length / 48);
    expect(providerCalls).toEqual({ identitySingle: 0, identityBatch: expectedBatches, visibilitySingle: 0, visibilityBatch: expectedBatches, mediaSingle: 0, mediaBatch: expectedBatches });
  });

  test("sitemap and structural authorization adapters share effective visibility", async () => {
    // Break caught: sitemap/media/report adapters bypass the same visibility policy or disclose a stale revision target.
    pageHoldIds = new Set(); showcaseHoldIds = new Set(); publishingMode = "general_audience";
    const creator = await publishCreator(`adapters-${randomUUID().slice(0, 6)}`);
    const handle = (await db.select().from(creatorHandleClaims).where(eq(creatorHandleClaims.pageId, creator.pageId)))[0]!.normalizedHandle;
    const { query } = composition();
    const sitemap = await query.listSitemapCreators();
    expect(sitemap).toContain(handle);
    expect(await query.isDerivativePublic(db, creator.avatar.assetId, "thumb")).toBe(true);
    for (const asset of [creator.avatar, creator.cover, creator.showcaseAssets[0]!]) {
      for (const variant of ["thumb", "display", "large"] as const) expect(await query.isDerivativePreviewable(db, creator.userId, asset.assetId, variant)).toBe(true);
    }
    expect(await query.isDerivativePublic(db, creator.avatar.assetId, "display")).toBe(true);
    expect(await query.isDerivativePublic(db, creator.avatar.assetId, "large")).toBe(false);
    expect(await query.isDerivativePublic(db, creator.cover.assetId, "thumb")).toBe(false);
    expect(await query.isDerivativePublic(db, creator.cover.assetId, "display")).toBe(true);
    expect(await query.isDerivativePublic(db, creator.cover.assetId, "large")).toBe(false);
    for (const variant of ["thumb", "display", "large"] as const) expect(await query.isDerivativePublic(db, creator.showcaseAssets[0]!.assetId, variant)).toBe(true);
    expect(await query.isDerivativePreviewable(db, `foreign-${randomUUID()}`, creator.avatar.assetId, "thumb")).toBe(false);
    expect(await query.isDerivativePreviewable(db, creator.userId, randomUUID(), "thumb")).toBe(false);
    expect(await query.isDerivativePreviewable(db, creator.userId, "malformed", "thumb")).toBe(false);
    const pageTarget = { targetType: "page", targetId: creator.pageId, publicationRevisionId: creator.revisionId } as const;
    const exactPageTarget = { target: pageTarget, pageId: creator.pageId, creatorUserId: creator.userId, canonicalHandle: handle, displayName: `Creator ${handle}`, showcaseTitle: null, mediaAssetIds: [creator.avatar.assetId, creator.cover.assetId, creator.showcaseAssets[0]!.assetId] };
    expect(await query.resolveVisibleReportTarget(db, pageTarget)).toEqual(exactPageTarget);
    expect(await query.readRevisionTarget(db, pageTarget)).toEqual(exactPageTarget);
    const showcaseTarget = { targetType: "showcase", targetId: creator.showcaseIds[0]!, publicationRevisionId: creator.revisionId } as const;
    expect(await query.resolveVisibleReportTarget(db, showcaseTarget)).toEqual({ target: showcaseTarget, pageId: creator.pageId, creatorUserId: creator.userId, canonicalHandle: handle, displayName: `Creator ${handle}`, showcaseTitle: `${handle} work 0`, mediaAssetIds: [creator.showcaseAssets[0]!.assetId] });
    expect(await query.resolveVisibleReportTarget(db, { ...showcaseTarget, targetId: randomUUID() })).toBeNull();
    expect(await query.readRevisionTarget(db, { ...showcaseTarget, publicationRevisionId: randomUUID() })).toBeNull();
    expect(await query.resolveVisibleReportTarget(db, { ...pageTarget, targetId: randomUUID() })).toBeNull();
    expect(await query.readRevisionTarget(db, { ...showcaseTarget, targetId: randomUUID() })).toBeNull();
    expect(await query.readRevisionTarget(db, { targetType: "page", targetId: "malformed", publicationRevisionId: creator.revisionId })).toBeNull();
    expect(await query.readRevisionTarget(db, { targetType: "page", targetId: creator.pageId, publicationRevisionId: "malformed" })).toBeNull();
    expect(await query.readRevisionTarget(db, { targetType: "invalid", targetId: creator.pageId, publicationRevisionId: creator.revisionId } as never)).toBeNull();
    pageHoldIds.add(creator.pageId);
    expect(await query.listSitemapCreators()).not.toContain(handle);
    expect(await query.isDerivativePublic(db, creator.avatar.assetId, "thumb")).toBe(false);
    expect(await query.resolveVisibleReportTarget(db, pageTarget)).toBeNull();
  });

  test("an unknown derivative is rejected by targeted joins without resolving or scanning catalog media", async () => {
    pageHoldIds = new Set(); showcaseHoldIds = new Set(); publishingMode = "general_audience";
    await publishCreator(`targeted-${randomUUID().slice(0, 5)}`);
    mediaResolveCalls = 0;
    expect(await composition().query.isDerivativePublic(db, randomUUID(), "display")).toBe(false);
    expect(mediaResolveCalls).toBe(0);
  });

  test("visible moderation targets exclude held showcases while historical targets remain exact and target-scoped", async () => {
    pageHoldIds = new Set(); showcaseHoldIds = new Set(); publishingMode = "general_audience";
    const creator = await publishCreator(`target-${randomUUID().slice(0, 6)}`, { showcases: 2 });
    const handle = (await db.select().from(creatorHandleClaims).where(eq(creatorHandleClaims.pageId, creator.pageId))).find((claim) => claim.kind === "canonical")!.normalizedHandle;
    showcaseHoldIds.add(creator.showcaseIds[0]!);
    const { query } = composition();
    const pageTarget = { targetType: "page", targetId: creator.pageId, publicationRevisionId: creator.revisionId } as const;
    expect(await query.resolveVisibleReportTarget(db, pageTarget)).toEqual({ target: pageTarget, pageId: creator.pageId, creatorUserId: creator.userId, canonicalHandle: handle, displayName: `Creator ${handle}`, showcaseTitle: null, mediaAssetIds: [creator.avatar.assetId, creator.cover.assetId, creator.showcaseAssets[1]!.assetId] });
    const heldTarget = { targetType: "showcase", targetId: creator.showcaseIds[0]!, publicationRevisionId: creator.revisionId } as const;
    expect(await query.resolveVisibleReportTarget(db, heldTarget)).toBeNull();
    expect(await query.readRevisionTarget(db, heldTarget)).toEqual({ target: heldTarget, pageId: creator.pageId, creatorUserId: creator.userId, canonicalHandle: handle, displayName: `Creator ${handle}`, showcaseTitle: `${handle} work 0`, mediaAssetIds: [creator.showcaseAssets[0]!.assetId] });
  });

  test("normalizes exact moderation targets and rejects extras, prototypes, accessors, and malformed identities symmetrically", async () => {
    pageHoldIds = new Set(); showcaseHoldIds = new Set(); publishingMode = "general_audience"; boundaryGetterCalls = 0;
    const creator = await publishCreator(`targetshape-${randomUUID().slice(0, 4)}`);
    const query = composition().query;
    const target = { targetType: "page", targetId: creator.pageId, publicationRevisionId: creator.revisionId } as const;
    const visible = await query.resolveVisibleReportTarget(db, target);
    const historical = await query.readRevisionTarget(db, target);
    expect(visible?.target).toEqual(target);
    expect(historical?.target).toEqual(target);
    expect(visible?.target).not.toBe(target);
    expect(historical?.target).not.toBe(target);

    const accessor = { targetType: "page", publicationRevisionId: creator.revisionId } as Record<string, unknown>;
    Object.defineProperty(accessor, "targetId", { enumerable: true, get() { boundaryGetterCalls += 1; return creator.pageId; } });
    const malformed = [
      { ...target, unexpected: true },
      Object.assign(Object.create({ targetId: target.targetId }), { targetType: target.targetType, publicationRevisionId: target.publicationRevisionId }),
      new Proxy(target, {}),
      accessor,
      { ...target, targetType: "invalid" },
      { ...target, targetId: randomUUID() },
      { ...target, targetId: "malformed" },
      { ...target, publicationRevisionId: randomUUID() },
      { ...target, publicationRevisionId: "malformed" },
      null,
    ];
    for (const candidate of malformed) {
      expect(await query.resolveVisibleReportTarget(db, candidate as never)).toBeNull();
      expect(await query.readRevisionTarget(db, candidate as never)).toBeNull();
    }
    expect(boundaryGetterCalls).toBe(0);
  });

  test.each([
    ["canonicalHandle", { canonicalHandle: `mismatch-${randomUUID().slice(0, 6)}` }],
    ["displayName", { displayName: "Tampered" }],
    ["introduction", { shortIntroduction: "Tampered" }],
    ["disciplines", { disciplines: ["drawing"] as string[] }],
    ["avatar", { avatarThumbDerivativeId: null }],
    ["timestamp", { revisionAt: new Date(at.getTime() + 1_000) }],
  ] as const)("fails closed across all consumers for a mismatched projection %s", async (_field, mutation) => {
    pageHoldIds = new Set(); showcaseHoldIds = new Set(); publishingMode = "general_audience";
    const creator = await publishCreator(`projection-${randomUUID().slice(0, 5)}`);
    const handle = (await db.select().from(creatorHandleClaims).where(eq(creatorHandleClaims.pageId, creator.pageId))).find((claim) => claim.kind === "canonical")!.normalizedHandle;
    await db.update(creatorDiscoveryProjections).set(mutation).where(eq(creatorDiscoveryProjections.pageId, creator.pageId));
    const { query } = composition();
    const target = { targetType: "page", targetId: creator.pageId, publicationRevisionId: creator.revisionId } as const;
    expect(await query.resolvePublicCreator(handle)).toEqual({ kind: "not_found" });
    expect((await query.listPublicCreators({ discipline: null, handlePrefix: handle, cursor: null, limit: 24 })).items).toEqual([]);
    expect(await query.listSitemapCreators()).not.toContain(handle);
    expect(await query.isDerivativePublic(db, creator.avatar.assetId, "thumb")).toBe(false);
    expect(await query.resolveVisibleReportTarget(db, target)).toBeNull();
  });

  test.each(["missing", "extra", "bad_dimensions"] as const)("treats malformed MediaCatalogPort %s output as neutral denial", async (scenario) => {
    pageHoldIds = new Set(); showcaseHoldIds = new Set(); publishingMode = "general_audience";
    const creator = await publishCreator(`malformed-${randomUUID().slice(0, 5)}`);
    const handle = (await db.select().from(creatorHandleClaims).where(eq(creatorHandleClaims.pageId, creator.pageId))).find((claim) => claim.kind === "canonical")!.normalizedHandle;
    const original = creator.avatar;
    media.set(original.assetId, scenario === "missing"
      ? ({ ...original, derivatives: undefined } as unknown as ReadyMedia)
      : scenario === "extra"
        ? ({ ...original, derivatives: { ...original.derivatives, master: original.derivatives.large } } as unknown as ReadyMedia)
        : ({ ...original, derivatives: { ...original.derivatives, thumb: { ...original.derivatives.thumb, width: 0 } } } as ReadyMedia));
    const { query } = composition();
    const target = { targetType: "page", targetId: creator.pageId, publicationRevisionId: creator.revisionId } as const;
    expect(await query.resolvePublicCreator(handle)).toEqual({ kind: "not_found" });
    expect(await query.isDerivativePublic(db, original.assetId, "thumb")).toBe(false);
    expect(await query.isDerivativePreviewable(db, creator.userId, original.assetId, "thumb")).toBe(false);
    expect(await query.resolveVisibleReportTarget(db, target)).toBeNull();
  });

  test.each(["get_only", "missing", "extra", "wrong_key", "wrong_asset", "wrong_owner", "wrong_purpose"] as const)("denies public and preview reads for an inexact media map/value (%s)", async (scenario) => {
    pageHoldIds = new Set(); showcaseHoldIds = new Set(); publishingMode = "general_audience"; mediaMapMode = "exact";
    const creator = await publishCreator(`map-${randomUUID().slice(0, 6)}`);
    const handle = (await db.select().from(creatorHandleClaims).where(eq(creatorHandleClaims.pageId, creator.pageId))).find((claim) => claim.kind === "canonical")!.normalizedHandle;
    mediaMapMode = scenario;
    try {
      expect(await composition().query.resolvePublicCreator(handle)).toEqual({ kind: "not_found" });
      expect(await composition().query.isDerivativePreviewable(db, creator.userId, creator.avatar.assetId, "thumb")).toBe(false);
    } finally { mediaMapMode = "exact"; }
  });

  test.each(["outer_get_only", "outer_missing", "outer_extra"] as const)("denies public reads for an inexact batch media map (%s)", async (scenario) => {
    pageHoldIds = new Set(); showcaseHoldIds = new Set(); publishingMode = "general_audience"; mediaMapMode = "exact";
    const creator = await publishCreator(`outer-${randomUUID().slice(0, 5)}`);
    const handle = (await db.select().from(creatorHandleClaims).where(eq(creatorHandleClaims.pageId, creator.pageId))).find((claim) => claim.kind === "canonical")!.normalizedHandle;
    mediaMapMode = scenario;
    try { expect(await composition().query.resolvePublicCreator(handle)).toEqual({ kind: "not_found" }); }
    finally { mediaMapMode = "exact"; }
  });

  test.each(["masked_extra", "subclass", "proxy"] as const)("denies a spoofable inner media Map (%s)", async (scenario) => {
    pageHoldIds = new Set(); showcaseHoldIds = new Set(); publishingMode = "general_audience"; boundaryGetterCalls = 0;
    const creator = await publishCreator(`innermap-${randomUUID().slice(0, 5)}`);
    const handle = (await db.select().from(creatorHandleClaims).where(eq(creatorHandleClaims.pageId, creator.pageId))).find((claim) => claim.kind === "canonical")!.normalizedHandle;
    mediaMapMode = scenario;
    try { expect(await composition().query.resolvePublicCreator(handle)).toEqual({ kind: "not_found" }); expect(boundaryGetterCalls).toBe(0); }
    finally { mediaMapMode = "exact"; }
  });

  test.each(["outer_masked_extra", "outer_subclass", "outer_proxy"] as const)("denies a spoofable outer media Map (%s)", async (scenario) => {
    pageHoldIds = new Set(); showcaseHoldIds = new Set(); publishingMode = "general_audience"; boundaryGetterCalls = 0;
    const creator = await publishCreator(`outermap-${randomUUID().slice(0, 4)}`);
    const handle = (await db.select().from(creatorHandleClaims).where(eq(creatorHandleClaims.pageId, creator.pageId))).find((claim) => claim.kind === "canonical")!.normalizedHandle;
    mediaMapMode = scenario;
    try { expect(await composition().query.resolvePublicCreator(handle)).toEqual({ kind: "not_found" }); expect(boundaryGetterCalls).toBe(0); }
    finally { mediaMapMode = "exact"; }
  });

  test.each(["extra", "prototype", "accessor", "proxy", "derivative_extra", "derivative_prototype", "derivative_accessor"] as const)("denies an inexact ReadyMedia record (%s) without invoking accessors", async (scenario) => {
    pageHoldIds = new Set(); showcaseHoldIds = new Set(); publishingMode = "general_audience"; boundaryGetterCalls = 0;
    const creator = await publishCreator(`mediavalue-${randomUUID().slice(0, 4)}`);
    const handle = (await db.select().from(creatorHandleClaims).where(eq(creatorHandleClaims.pageId, creator.pageId))).find((claim) => claim.kind === "canonical")!.normalizedHandle;
    mediaValueMode = scenario;
    try {
      expect(await composition().query.resolvePublicCreator(handle)).toEqual({ kind: "not_found" });
      expect(await composition().query.isDerivativePreviewable(db, creator.userId, creator.avatar.assetId, "thumb")).toBe(false);
      expect(boundaryGetterCalls).toBe(0);
    } finally { mediaValueMode = "exact"; }
  });

  test.each(["extra", "prototype", "accessor", "proxy"] as const)("denies an inexact Identity seed (%s) without invoking accessors", async (scenario) => {
    pageHoldIds = new Set(); showcaseHoldIds = new Set(); publishingMode = "general_audience"; boundaryGetterCalls = 0;
    const creator = await publishCreator(`seedvalue-${randomUUID().slice(0, 4)}`);
    const handle = (await db.select().from(creatorHandleClaims).where(eq(creatorHandleClaims.pageId, creator.pageId))).find((claim) => claim.kind === "canonical")!.normalizedHandle;
    identityValueMode = scenario;
    try {
      expect(await composition().query.resolvePublicCreator(handle)).toEqual({ kind: "not_found" });
      expect(await composition().query.isDerivativePreviewable(db, creator.userId, creator.avatar.assetId, "thumb")).toBe(false);
      expect(boundaryGetterCalls).toBe(0);
    }
    finally { identityValueMode = "exact"; }
  });

  test.each(["masked_extra", "subclass", "proxy"] as const)("denies a spoofable Identity batch Map (%s)", async (scenario) => {
    pageHoldIds = new Set(); showcaseHoldIds = new Set(); publishingMode = "general_audience"; boundaryGetterCalls = 0;
    const creator = await publishCreator(`seedmap-${randomUUID().slice(0, 5)}`);
    const handle = (await db.select().from(creatorHandleClaims).where(eq(creatorHandleClaims.pageId, creator.pageId))).find((claim) => claim.kind === "canonical")!.normalizedHandle;
    identityBatchMode = scenario;
    try { expect(await composition().query.resolvePublicCreator(handle)).toEqual({ kind: "not_found" }); expect(boundaryGetterCalls).toBe(0); }
    finally { identityBatchMode = "exact"; }
  });

  test.each(["extra", "prototype", "accessor", "proxy"] as const)("denies an inexact hold snapshot (%s) without invoking accessors", async (scenario) => {
    pageHoldIds = new Set(); showcaseHoldIds = new Set(); publishingMode = "general_audience"; boundaryGetterCalls = 0;
    const creator = await publishCreator(`holdvalue-${randomUUID().slice(0, 4)}`);
    const handle = (await db.select().from(creatorHandleClaims).where(eq(creatorHandleClaims.pageId, creator.pageId))).find((claim) => claim.kind === "canonical")!.normalizedHandle;
    holdValueMode = scenario;
    try { expect(await composition().query.resolvePublicCreator(handle)).toEqual({ kind: "not_found" }); expect(boundaryGetterCalls).toBe(0); }
    finally { holdValueMode = "exact"; }
  });

  test.each(["masked_extra", "subclass", "proxy"] as const)("denies a spoofable held-showcase Set (%s)", async (scenario) => {
    pageHoldIds = new Set(); showcaseHoldIds = new Set(); publishingMode = "general_audience"; boundaryGetterCalls = 0;
    const creator = await publishCreator(`holdset-${randomUUID().slice(0, 5)}`);
    const handle = (await db.select().from(creatorHandleClaims).where(eq(creatorHandleClaims.pageId, creator.pageId))).find((claim) => claim.kind === "canonical")!.normalizedHandle;
    holdSetMode = scenario;
    try { expect(await composition().query.resolvePublicCreator(handle)).toEqual({ kind: "not_found" }); expect(boundaryGetterCalls).toBe(0); }
    finally { holdSetMode = "exact"; }
  });

  test.each(["masked_extra", "subclass", "proxy"] as const)("denies a spoofable Visibility batch Map (%s)", async (scenario) => {
    pageHoldIds = new Set(); showcaseHoldIds = new Set(); publishingMode = "general_audience"; boundaryGetterCalls = 0;
    const creator = await publishCreator(`holdmap-${randomUUID().slice(0, 5)}`);
    const handle = (await db.select().from(creatorHandleClaims).where(eq(creatorHandleClaims.pageId, creator.pageId))).find((claim) => claim.kind === "canonical")!.normalizedHandle;
    visibilityBatchMode = scenario;
    try { expect(await composition().query.resolvePublicCreator(handle)).toEqual({ kind: "not_found" }); expect(boundaryGetterCalls).toBe(0); }
    finally { visibilityBatchMode = "exact"; }
  });

  test.each(["identity_missing", "identity_extra", "visibility_missing", "visibility_extra"] as const)("fails closed for an inexact provider batch result (%s)", async (scenario) => {
    pageHoldIds = new Set(); showcaseHoldIds = new Set(); publishingMode = "general_audience";
    const creator = await publishCreator(`provider-${randomUUID().slice(0, 4)}`);
    const handle = (await db.select().from(creatorHandleClaims).where(eq(creatorHandleClaims.pageId, creator.pageId))).find((claim) => claim.kind === "canonical")!.normalizedHandle;
    identityBatchMode = scenario.startsWith("identity") ? (scenario.endsWith("missing") ? "missing" : "extra") : "exact";
    visibilityBatchMode = scenario.startsWith("visibility") ? (scenario.endsWith("missing") ? "missing" : "extra") : "exact";
    try { expect(await composition().query.resolvePublicCreator(handle)).toEqual({ kind: "not_found" }); }
    finally { identityBatchMode = "exact"; visibilityBatchMode = "exact"; }
  });

  test("private preview fails neutrally for a referenced asset that is no longer ready", async () => {
    pageHoldIds = new Set(); showcaseHoldIds = new Set(); publishingMode = "general_audience";
    const creator = await publishCreator(`notready-${randomUUID().slice(0, 6)}`);
    media.delete(creator.cover.assetId);
    expect(await composition().query.isDerivativePreviewable(db, creator.userId, creator.cover.assetId, "large")).toBe(false);
  });

  test("holds the visibility fence through report commit when reporting wins the page race", async () => {
    pageHoldIds = new Set(); showcaseHoldIds = new Set(); publishingMode = "general_audience";
    const creator = await publishCreator(`report-first-${randomUUID().slice(0, 5)}`);
    const catalog = composition();
    const target = { targetType: "page", targetId: creator.pageId, publicationRevisionId: creator.revisionId } as const;
    const resolved = deferred();
    const release = deferred();
    const reportPromise = db.transaction(async (tx) => {
      const snapshot = await catalog.query.resolveVisibleReportTarget(tx, target);
      resolved.resolve();
      await release.promise;
      if (!snapshot) return { accepted: false } as const;
      const reportId = randomUUID();
      await tx.insert(publicContentReports).values({
        id: reportId, reportReference: `report:v1:${randomUUID().replaceAll("-", "")}`,
        targetType: target.targetType, targetId: target.targetId,
        publicationRevisionId: target.publicationRevisionId, reason: "privacy", detail: null,
        reporterUserId: creator.userId, state: "open", version: 1, createdAt: at, updatedAt: at,
      });
      return { accepted: true } as const;
    });
    await resolved.promise;
    const unpublishPromise = catalog.service.unpublish({
      actor: actor(creator.userId), pageId: creator.pageId, expectedVersion: creator.version,
      idempotencyKey: `report-race-unpublish-${creator.pageId}`, requestId: `report-race-unpublish-${creator.pageId}`,
    });
    const observedBeforeReportCommit = await Promise.race([
      unpublishPromise.then(() => "unpublished" as const),
      new Promise<"blocked">((done) => setTimeout(() => done("blocked"), 100)),
    ]);
    release.resolve();
    const report = await reportPromise;
    await unpublishPromise;
    expect(observedBeforeReportCommit).toBe("blocked");
    expect(report.accepted).toBe(true);
  });

  test("rejects the report when unpublish is queued first on the visibility fence", async () => {
    pageHoldIds = new Set(); showcaseHoldIds = new Set(); publishingMode = "general_audience";
    const creator = await publishCreator(`unpublish-first-${randomUUID().slice(0, 4)}`);
    const catalog = composition();
    const target = { targetType: "page", targetId: creator.pageId, publicationRevisionId: creator.revisionId } as const;
    const locked = deferred();
    const release = deferred();
    const blocker = db.transaction(async (tx) => {
      await tx.select({ id: creatorPages.id }).from(creatorPages).where(eq(creatorPages.id, creator.pageId)).for("update");
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const unpublishPromise = catalog.service.unpublish({
      actor: actor(creator.userId), pageId: creator.pageId, expectedVersion: creator.version,
      idempotencyKey: `queued-unpublish-${creator.pageId}`, requestId: `queued-unpublish-${creator.pageId}`,
    });
    await new Promise((done) => setTimeout(done, 50));
    const reportPromise = db.transaction(async (tx) => {
      const snapshot = await catalog.query.resolveVisibleReportTarget(tx, target);
      if (!snapshot) return { accepted: false } as const;
      const reportId = randomUUID();
      await tx.insert(publicContentReports).values({
        id: reportId, reportReference: `report:v1:${randomUUID().replaceAll("-", "")}`,
        targetType: target.targetType, targetId: target.targetId,
        publicationRevisionId: target.publicationRevisionId, reason: "privacy", detail: null,
        reporterUserId: creator.userId, state: "open", version: 1, createdAt: at, updatedAt: at,
      });
      return { accepted: true } as const;
    });
    await new Promise((done) => setTimeout(done, 50));
    release.resolve();
    await blocker;
    await unpublishPromise;
    await expect(reportPromise).resolves.toEqual({ accepted: false });
  });
});
