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

const creatorSeeds = {
  async getCreatorSeed(_database: unknown, userId: string): Promise<CreatorSeed | null> {
    const capabilityState = capabilities.get(userId);
    if (!capabilityState) return null;
    return { userId, capabilityState, capabilityVersion: 1, approvedRevisionId: randomUUID(), displayName: "Seed", introduction: "Seed intro" };
  },
};
const mediaCatalog = {
  async resolveReadyAssets(_database: unknown, ownerUserId: string, references: readonly MediaReference[]) {
    mediaResolveCalls += 1;
    return new Map(references.flatMap((reference) => {
      const asset = media.get(reference.assetId);
      return asset?.ownerUserId === ownerUserId && asset.purpose === reference.purpose ? [[asset.assetId, asset] as const] : [];
    }));
  },
};
const visibility = {
  async readHolds(_database: unknown, pageId: string, _revisionId: string, showcaseIds: readonly string[]) {
    return { pageHeld: pageHoldIds.has(pageId), heldShowcaseIds: new Set(showcaseIds.filter((id) => showcaseHoldIds.has(id))) };
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

  test("directory keyset batches past more than one full hidden candidate batch without duplicates", async () => {
    pageHoldIds = new Set(); showcaseHoldIds = new Set(); publishingMode = "general_audience";
    const prefix = `batch${randomUUID().slice(0, 4)}`;
    for (let index = 0; index < 51; index += 1) {
      const hidden = await publishCreator(`${prefix}-${index.toString().padStart(3, "0")}`, { showcases: 0 });
      pageHoldIds.add(hidden.pageId);
    }
    for (let index = 51; index < 77; index += 1) await publishCreator(`${prefix}-${index.toString().padStart(3, "0")}`, { showcases: 0 });
    const { query } = composition();
    const first = await query.listPublicCreators({ discipline: null, handlePrefix: prefix, cursor: null, limit: 24 });
    const second = await query.listPublicCreators({ discipline: null, handlePrefix: prefix, cursor: first.nextCursor, limit: 24 });
    expect(first.items).toHaveLength(24);
    expect(second.items).toHaveLength(2);
    expect(new Set([...first.items, ...second.items].map((item) => item.pageId)).size).toBe(26);
  }, 20_000);

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

  test("private preview fails neutrally for a referenced asset that is no longer ready", async () => {
    pageHoldIds = new Set(); showcaseHoldIds = new Set(); publishingMode = "general_audience";
    const creator = await publishCreator(`notready-${randomUUID().slice(0, 6)}`);
    media.delete(creator.cover.assetId);
    expect(await composition().query.isDerivativePreviewable(db, creator.userId, creator.cover.assetId, "large")).toBe(false);
  });
});
