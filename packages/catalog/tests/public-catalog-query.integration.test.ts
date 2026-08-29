import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createDatabase,
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

const creatorSeeds = {
  async getCreatorSeed(_database: unknown, userId: string): Promise<CreatorSeed | null> {
    const capabilityState = capabilities.get(userId);
    if (!capabilityState) return null;
    return { userId, capabilityState, capabilityVersion: 1, approvedRevisionId: randomUUID(), displayName: "Seed", introduction: "Seed intro" };
  },
};
const mediaCatalog = {
  async resolveReadyAssets(_database: unknown, ownerUserId: string, references: readonly MediaReference[]) {
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
  version = (await service.saveDraft({
    actor: actor(userId), pageId: initialized.pageId, expectedVersion: version, idempotencyKey: `draft-${handle}`, requestId: `draft-${handle}`,
    draft: { displayName: `Creator ${handle}`, introduction: `Introduction for ${handle}`, primaryDiscipline: options.discipline ?? "illustration", secondaryDisciplines: [], avatarAssetId: avatar.assetId, coverAssetId: null },
  })).draftVersion;
  const showcaseIds: string[] = [];
  for (let position = 0; position < (options.showcases ?? 1); position += 1) {
    const asset = readyMedia(userId, "showcase"); media.set(asset.assetId, asset);
    version = (await service.upsertShowcase({
      actor: actor(userId), pageId: initialized.pageId, expectedVersion: version, idempotencyKey: `showcase-${handle}-${position}`, requestId: `showcase-${handle}-${position}`,
      showcase: { position, title: `${handle} work ${position}`, description: "Public work", discipline: options.discipline ?? "illustration", contentLabel: "general_audience", externalUrl: null, media: [{ assetId: asset.assetId, alternativeText: `${handle} image ${position}` }] },
    })).draftVersion;
    const workspace = await service.getWorkspace({ actorUserId: userId, pageId: initialized.pageId });
    showcaseIds.push(workspace.showcases[position]!.id);
  }
  const published = await service.publish({ actor: actor(userId), pageId: initialized.pageId, expectedVersion: version, idempotencyKey: `publish-${handle}`, requestId: `publish-${handle}` });
  return { userId, pageId: initialized.pageId, revisionId: published.revisionId, showcaseIds, avatar, version };
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

  test("sitemap and structural authorization adapters share effective visibility", async () => {
    // Break caught: sitemap/media/report adapters bypass the same visibility policy or disclose a stale revision target.
    pageHoldIds = new Set(); showcaseHoldIds = new Set(); publishingMode = "general_audience";
    const creator = await publishCreator(`adapters-${randomUUID().slice(0, 6)}`);
    const handle = (await db.select().from(creatorHandleClaims).where(eq(creatorHandleClaims.pageId, creator.pageId)))[0]!.normalizedHandle;
    const { query } = composition();
    const sitemap = await query.listSitemapCreators();
    expect(sitemap).toContain(handle);
    expect(await query.isDerivativePublic(db, creator.avatar.assetId, "thumb")).toBe(true);
    expect(await query.isDerivativePreviewable(db, creator.userId, creator.avatar.assetId, "thumb")).toBe(true);
    expect(await query.isDerivativePreviewable(db, creator.userId, creator.avatar.assetId, "large")).toBe(false);
    expect(await query.isDerivativePreviewable(db, `foreign-${randomUUID()}`, creator.avatar.assetId, "thumb")).toBe(false);
    const pageTarget = { targetType: "page", targetId: creator.pageId, publicationRevisionId: creator.revisionId } as const;
    expect(await query.resolveVisibleReportTarget(db, pageTarget)).toMatchObject({ target: pageTarget, pageId: creator.pageId, mediaAssetIds: expect.arrayContaining([creator.avatar.assetId]) });
    expect(await query.readRevisionTarget(db, pageTarget)).toMatchObject({ target: pageTarget, pageId: creator.pageId, mediaAssetIds: expect.arrayContaining([creator.avatar.assetId]) });
    pageHoldIds.add(creator.pageId);
    expect(await query.listSitemapCreators()).not.toContain(handle);
    expect(await query.isDerivativePublic(db, creator.avatar.assetId, "thumb")).toBe(false);
    expect(await query.resolveVisibleReportTarget(db, pageTarget)).toBeNull();
  });
});
