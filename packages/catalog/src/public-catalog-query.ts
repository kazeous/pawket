import { Buffer } from "node:buffer";
import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import {
  creatorDiscoveryProjections, creatorHandleClaims, creatorPageDrafts, creatorPages,
  creatorPublicationMedia, creatorPublicationRevisions, creatorPublicationShowcases,
  creatorShowcaseDraftMedia, creatorShowcaseDrafts, type PawketDatabase, type PawketTransaction,
} from "@pawket/database";
import { CONTENT_POLICY_VERSION, DISCIPLINES, TAXONOMY_VERSION, type Discipline } from "./catalog-policy.js";
import type { IdentityCreatorSeedPort, MediaCatalogPort, MediaReference, ReadyMedia, VisibilityReadPort } from "./catalog-ports.js";

export type PublicDerivative = Readonly<{ derivativeId: string; width: number; height: number }>;
export type PublicCreatorMedia = Readonly<{ assetId: string; thumbDerivativeId: string; displayDerivativeId: string; largeDerivativeId: string; alternativeText: string; dimensions: Readonly<Record<"thumb" | "display" | "large", Readonly<{ width: number; height: number }>>> }>;
export type PublicCreatorShowcase = Readonly<{ sourceShowcaseId: string; position: number; title: string; description: string; discipline: Discipline; contentLabel: "general_audience"; externalUrl: string | null; media: readonly PublicCreatorMedia[] }>;
export type PublicCreatorPage = Readonly<{ pageId: string; revisionId: string; revisionNumber: number; canonicalHandle: string; displayName: string; introduction: string; primaryDiscipline: Discipline; secondaryDisciplines: readonly Discipline[]; avatar: Readonly<{ assetId: string; thumb: PublicDerivative; display: PublicDerivative }> | null; cover: Readonly<{ assetId: string; display: PublicDerivative }> | null; showcases: readonly PublicCreatorShowcase[]; publishedAt: Date }>;
export type PublicCreatorResolution = { kind: "not_found" } | { kind: "redirect"; canonicalHandle: string } | { kind: "visible"; page: PublicCreatorPage };
export type DirectoryQuery = Readonly<{ discipline: Discipline | null; handlePrefix: string; cursor: string | null; limit: 24 }>;
export type PublicCreatorDirectoryItem = Readonly<{ pageId: string; canonicalHandle: string; displayName: string; introduction: string; disciplines: readonly Discipline[]; avatarThumbDerivativeId: string | null }>;
export type PublicCreatorDirectoryPage = Readonly<{ items: readonly PublicCreatorDirectoryItem[]; nextCursor: string | null }>;
export type ReportTarget = Readonly<{ targetType: "page" | "showcase"; targetId: string; publicationRevisionId: string }>;
export type ModerationTargetSnapshot = Readonly<{ target: ReportTarget; pageId: string; creatorUserId: string; canonicalHandle: string; displayName: string; showcaseTitle: string | null; mediaAssetIds: readonly string[] }>;

type Input = Readonly<{ db: PawketDatabase; creatorSeeds: IdentityCreatorSeedPort; mediaCatalog: MediaCatalogPort; visibility: VisibilityReadPort; publishingMode: "disabled" | "general_audience" }>;
type Database = PawketDatabase | PawketTransaction;
type Variant = "thumb" | "display" | "large";
type Candidate = { pageId: string; canonicalHandle: string };
type Effective = { page: PublicCreatorPage; creatorUserId: string };
export const PUBLIC_CATALOG_QUERY_BATCH_SIZE = 48;
export const PUBLIC_DIRECTORY_CANDIDATE_SCAN_BUDGET = 96;
export class PublicCatalogQueryError extends Error { constructor(readonly code: "INVALID_QUERY" | "INVALID_CURSOR") { super(code); } }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PUBLIC_HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const HANDLE_PREFIX = /^[a-z0-9-]{1,30}$/u;
const VARIANTS = ["display", "large", "thumb"] as const;
function isUuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
function isDiscipline(value: unknown): value is Discipline { return typeof value === "string" && (DISCIPLINES as readonly string[]).includes(value); }
function isVariant(value: unknown): value is Variant { return value === "thumb" || value === "display" || value === "large"; }
function publicHandle(value: unknown): value is string { return typeof value === "string" && value.length >= 3 && value.length <= 30 && PUBLIC_HANDLE.test(value); }
function sameStrings(value: unknown, expected: readonly string[]): boolean { return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]); }
function unique(values: readonly (string | null)[]): string[] { return [...new Set(values.filter((value): value is string => value !== null))]; }
function encodeCursor(handle: string, pageId: string): string { return Buffer.from(JSON.stringify(["v1", handle, pageId]), "utf8").toString("base64url"); }
function decodeCursor(value: string): { handle: string; pageId: string } {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(decoded) || decoded.length !== 3 || decoded[0] !== "v1" || !publicHandle(decoded[1]) || !isUuid(decoded[2]) || encodeCursor(decoded[1], decoded[2]) !== value) throw new Error("invalid");
    return { handle: decoded[1], pageId: decoded[2] };
  } catch { throw new PublicCatalogQueryError("INVALID_CURSOR"); }
}
function exactMedia(reference: MediaReference, value: unknown, ownerUserId: string): ReadyMedia | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<ReadyMedia> & { derivatives?: unknown };
  if (item.assetId !== reference.assetId || item.ownerUserId !== ownerUserId || item.purpose !== reference.purpose) return null;
  if (!item.derivatives || typeof item.derivatives !== "object" || Array.isArray(item.derivatives) || Object.keys(item.derivatives).sort().join(",") !== VARIANTS.join(",")) return null;
  for (const variant of VARIANTS) {
    const value = (item.derivatives as Record<string, unknown>)[variant];
    if (!value || typeof value !== "object") return null;
    const derivative = value as { derivativeId?: unknown; width?: unknown; height?: unknown };
    if (!isUuid(derivative.derivativeId) || !Number.isInteger(derivative.width) || (derivative.width as number) <= 0 || !Number.isInteger(derivative.height) || (derivative.height as number) <= 0) return null;
  }
  return item as ReadyMedia;
}
function exactMap(value: unknown, expectedKeys: readonly string[]): Map<unknown, unknown> | null {
  if (!(value instanceof Map)) return null;
  const expected = new Set(expectedKeys);
  if (value.size !== expected.size || [...value.keys()].some((key) => typeof key !== "string" || !expected.has(key))) return null;
  return value;
}
function exactSeed(value: unknown, userId: string): value is NonNullable<Awaited<ReturnType<IdentityCreatorSeedPort["getCreatorSeed"]>>> {
  if (!value || typeof value !== "object") return false;
  const seed = value as Record<string, unknown>;
  return Object.keys(seed).sort().join(",") === "approvedRevisionId,capabilityState,capabilityVersion,displayName,introduction,userId"
    && seed.userId === userId && (seed.capabilityState === "active" || seed.capabilityState === "suspended")
    && Number.isInteger(seed.capabilityVersion) && (seed.capabilityVersion as number) > 0 && isUuid(seed.approvedRevisionId)
    && typeof seed.displayName === "string" && typeof seed.introduction === "string";
}
function derivative(item: ReadyMedia, variant: Variant): PublicDerivative { const value = item.derivatives[variant]; return { derivativeId: value.derivativeId, width: value.width, height: value.height }; }

export function createPublicCatalogQuery(input: Input) {
  async function loadEffectiveBatch(database: Database, requestedIds: readonly string[]): Promise<Map<string, Effective>> {
    const result = new Map<string, Effective>();
    const pageIds = unique(requestedIds).slice(0, PUBLIC_CATALOG_QUERY_BATCH_SIZE);
    if (input.publishingMode !== "general_audience" || pageIds.length === 0 || pageIds.some((id) => !isUuid(id))) return result;
    const pages = (await database.select().from(creatorPages).where(inArray(creatorPages.id, pageIds))).filter((page) => page.publishedRevisionId !== null);
    if (pages.length === 0) return result;
    const projections = await database.select().from(creatorDiscoveryProjections).where(inArray(creatorDiscoveryProjections.pageId, pages.map((page) => page.id)));
    const revisionIds = pages.map((page) => page.publishedRevisionId!);
    const revisions = await database.select().from(creatorPublicationRevisions).where(inArray(creatorPublicationRevisions.id, revisionIds));
    const claims = await database.select().from(creatorHandleClaims).where(inArray(creatorHandleClaims.pageId, pages.map((page) => page.id)));
    const showcases = await database.select().from(creatorPublicationShowcases).where(inArray(creatorPublicationShowcases.revisionId, revisionIds)).orderBy(asc(creatorPublicationShowcases.revisionId), asc(creatorPublicationShowcases.position));
    const mediaRows = showcases.length === 0 ? [] : await database.select().from(creatorPublicationMedia).where(inArray(creatorPublicationMedia.publicationShowcaseId, showcases.map((showcase) => showcase.id))).orderBy(asc(creatorPublicationMedia.publicationShowcaseId), asc(creatorPublicationMedia.position));
    try {
      const contexts = pages.flatMap((page) => {
        const revision = revisions.find((item) => item.id === page.publishedRevisionId && item.pageId === page.id);
        const projection = projections.find((item) => item.pageId === page.id);
        const canonical = claims.find((item) => item.pageId === page.id && item.kind === "canonical");
        if (!revision || !projection || !canonical || !publicHandle(canonical.normalizedHandle)) return [];
        if (!claims.some((item) => item.pageId === page.id && item.normalizedHandle === revision.canonicalHandle)) return [];
        if (revision.taxonomyVersion !== TAXONOMY_VERSION || revision.policyVersion !== CONTENT_POLICY_VERSION || !isDiscipline(revision.primaryDiscipline) || !revision.secondaryDisciplines.every(isDiscipline)) return [];
        const expectedDisciplines = [revision.primaryDiscipline, ...revision.secondaryDisciplines];
        if (projection.enabled !== true || projection.revisionId !== revision.id || projection.canonicalHandle !== canonical.normalizedHandle || projection.displayName !== revision.displayName || projection.shortIntroduction !== revision.shortIntroduction || !sameStrings(projection.disciplines, expectedDisciplines) || projection.avatarThumbDerivativeId !== revision.avatarThumbDerivativeId || projection.revisionAt.getTime() !== revision.publishedAt.getTime()) return [];
        const revisionShowcases = showcases.filter((item) => item.revisionId === revision.id);
        return [{ page, revision, canonical, revisionShowcases }];
      });
      const userIds = unique(contexts.map((context) => context.page.userId));
      const seedMap = exactMap(await input.creatorSeeds.getCreatorSeeds(database, userIds), userIds);
      if (!seedMap) return result;
      const active = contexts.filter((context) => {
        const seed = seedMap.get(context.page.userId);
        return exactSeed(seed, context.page.userId) && seed.capabilityState === "active";
      });
      const holdRequests = active.map((context) => ({ pageId: context.page.id, revisionId: context.revision.id, showcaseIds: context.revisionShowcases.map((showcase) => showcase.sourceShowcaseId) }));
      const holdMap = exactMap(await input.visibility.readHoldsBatch(database, holdRequests), holdRequests.map((request) => request.pageId));
      if (!holdMap) return result;
      const heldChecked = active.flatMap((context) => {
        const holds = holdMap.get(context.page.id);
        const request = holdRequests.find((item) => item.pageId === context.page.id)!;
        if (!holds || typeof holds !== "object") return [];
        const snapshot = holds as { pageHeld?: unknown; heldShowcaseIds?: unknown };
        if (typeof snapshot.pageHeld !== "boolean" || !(snapshot.heldShowcaseIds instanceof Set) || [...snapshot.heldShowcaseIds].some((id) => typeof id !== "string" || !request.showcaseIds.includes(id))) return [];
        if (snapshot.pageHeld) return [];
        return [{ ...context, heldShowcaseIds: snapshot.heldShowcaseIds as Set<string> }];
      });
      const mediaContexts = heldChecked.flatMap((context) => {
        const visibleShowcases = context.revisionShowcases.filter((showcase) => !context.heldShowcaseIds.has(showcase.sourceShowcaseId));
        if (visibleShowcases.some((showcase) => !isDiscipline(showcase.discipline) || showcase.contentLabel !== "general_audience")) return [];
        const visibleIds = new Set(visibleShowcases.map((showcase) => showcase.id));
        const visibleMedia = mediaRows.filter((item) => visibleIds.has(item.publicationShowcaseId));
        const references: MediaReference[] = [];
        if (context.revision.avatarAssetId) references.push({ assetId: context.revision.avatarAssetId, purpose: "avatar", altText: null });
        if (context.revision.coverAssetId) references.push({ assetId: context.revision.coverAssetId, purpose: "cover", altText: null });
        for (const row of visibleMedia) references.push({ assetId: row.assetId, purpose: "showcase", altText: row.alternativeText });
        return [{ ...context, visibleShowcases, visibleMedia, references }];
      });
      const mediaRequests = mediaContexts.map((context) => ({ ownerUserId: context.page.userId, references: context.references }));
      const mediaBatch = exactMap(await input.mediaCatalog.resolveReadyAssetsBatch(database, mediaRequests), mediaRequests.map((request) => request.ownerUserId));
      if (!mediaBatch) return result;
      for (const context of mediaContexts) {
        const { page, revision, canonical, visibleShowcases, visibleMedia, references } = context;
        const resolved = exactMap(mediaBatch.get(page.userId), unique(references.map((reference) => reference.assetId)));
        if (!resolved) return new Map();
        const ready = new Map<string, ReadyMedia>();
        for (const reference of references) { const item = exactMedia(reference, resolved.get(reference.assetId), page.userId); if (!item) return new Map(); ready.set(reference.assetId, item); }
        const avatar = revision.avatarAssetId ? ready.get(revision.avatarAssetId) : undefined;
        const cover = revision.coverAssetId ? ready.get(revision.coverAssetId) : undefined;
        if (avatar && (avatar.derivatives.thumb.derivativeId !== revision.avatarThumbDerivativeId || avatar.derivatives.display.derivativeId !== revision.avatarDisplayDerivativeId)) return new Map();
        if (cover && cover.derivatives.display.derivativeId !== revision.coverDisplayDerivativeId) return new Map();
        const projected: PublicCreatorShowcase[] = [];
        for (const showcase of visibleShowcases) {
          const projectedMedia: PublicCreatorMedia[] = [];
          for (const row of visibleMedia.filter((item) => item.publicationShowcaseId === showcase.id)) {
            const item = ready.get(row.assetId);
            if (!item || item.derivatives.thumb.derivativeId !== row.thumbDerivativeId || item.derivatives.display.derivativeId !== row.displayDerivativeId || item.derivatives.large.derivativeId !== row.largeDerivativeId) return new Map();
            projectedMedia.push({ assetId: row.assetId, thumbDerivativeId: row.thumbDerivativeId, displayDerivativeId: row.displayDerivativeId, largeDerivativeId: row.largeDerivativeId, alternativeText: row.alternativeText, dimensions: { thumb: { width: item.derivatives.thumb.width, height: item.derivatives.thumb.height }, display: { width: item.derivatives.display.width, height: item.derivatives.display.height }, large: { width: item.derivatives.large.width, height: item.derivatives.large.height } } });
          }
          projected.push({ sourceShowcaseId: showcase.sourceShowcaseId, position: showcase.position, title: showcase.title, description: showcase.description, discipline: showcase.discipline as Discipline, contentLabel: "general_audience", externalUrl: showcase.externalUrl, media: projectedMedia });
        }
        result.set(page.id, { creatorUserId: page.userId, page: { pageId: page.id, revisionId: revision.id, revisionNumber: revision.revisionNumber, canonicalHandle: canonical.normalizedHandle, displayName: revision.displayName, introduction: revision.shortIntroduction, primaryDiscipline: revision.primaryDiscipline as Discipline, secondaryDisciplines: revision.secondaryDisciplines as Discipline[], avatar: avatar ? { assetId: avatar.assetId, thumb: derivative(avatar, "thumb"), display: derivative(avatar, "display") } : null, cover: cover ? { assetId: cover.assetId, display: derivative(cover, "display") } : null, showcases: projected, publishedAt: revision.publishedAt } });
      }
    } catch { return new Map(); }
    return result;
  }
  async function loadEffective(database: Database, pageId: string): Promise<Effective | null> { return (await loadEffectiveBatch(database, [pageId])).get(pageId) ?? null; }
  async function candidates(database: Database, query: { discipline?: Discipline | null; prefix?: string; after: { handle: string; pageId: string } | null }): Promise<Candidate[]> {
    const predicates = [eq(creatorDiscoveryProjections.enabled, true)];
    if (query.discipline) predicates.push(sql`${query.discipline} = any(${creatorDiscoveryProjections.disciplines})`);
    if (query.prefix) predicates.push(sql`${creatorDiscoveryProjections.canonicalHandle} like ${`${query.prefix}%`}`);
    if (query.after) predicates.push(or(gt(creatorDiscoveryProjections.canonicalHandle, query.after.handle), and(eq(creatorDiscoveryProjections.canonicalHandle, query.after.handle), gt(creatorDiscoveryProjections.pageId, query.after.pageId)))!);
    return database.select({ pageId: creatorDiscoveryProjections.pageId, canonicalHandle: creatorDiscoveryProjections.canonicalHandle }).from(creatorDiscoveryProjections).where(and(...predicates)).orderBy(asc(creatorDiscoveryProjections.canonicalHandle), asc(creatorDiscoveryProjections.pageId)).limit(PUBLIC_CATALOG_QUERY_BATCH_SIZE);
  }
  async function snapshot(database: Database, target: ReportTarget, visibleOnly: boolean): Promise<ModerationTargetSnapshot | null> {
    if (!target || !isUuid(target.targetId) || !isUuid(target.publicationRevisionId) || (target.targetType !== "page" && target.targetType !== "showcase")) return null;
    try {
      const [revision] = await database.select().from(creatorPublicationRevisions).where(eq(creatorPublicationRevisions.id, target.publicationRevisionId)).limit(1);
      if (!revision || !publicHandle(revision.canonicalHandle)) return null;
      const [page] = await database.select().from(creatorPages).where(eq(creatorPages.id, revision.pageId)).limit(1);
      if (!page) return null;
      if (visibleOnly) {
        const current = await loadEffective(database, page.id);
        if (!current || current.page.revisionId !== revision.id) return null;
        if (target.targetType === "page") {
          if (target.targetId !== page.id) return null;
          return { target, pageId: page.id, creatorUserId: page.userId, canonicalHandle: current.page.canonicalHandle, displayName: current.page.displayName, showcaseTitle: null, mediaAssetIds: unique([current.page.avatar?.assetId ?? null, current.page.cover?.assetId ?? null, ...current.page.showcases.flatMap((item) => item.media.map((media) => media.assetId))]) };
        }
        const selected = current.page.showcases.find((item) => item.sourceShowcaseId === target.targetId);
        return selected ? { target, pageId: page.id, creatorUserId: page.userId, canonicalHandle: current.page.canonicalHandle, displayName: current.page.displayName, showcaseTitle: selected.title, mediaAssetIds: unique(selected.media.map((item) => item.assetId)) } : null;
      }
      const allShowcases = await database.select().from(creatorPublicationShowcases).where(eq(creatorPublicationShowcases.revisionId, revision.id)).orderBy(asc(creatorPublicationShowcases.position));
      if (target.targetType === "page" && target.targetId !== page.id) return null;
      const selected = target.targetType === "page" ? allShowcases : allShowcases.filter((item) => item.sourceShowcaseId === target.targetId);
      if (target.targetType === "showcase" && selected.length !== 1) return null;
      const mediaRows = selected.length === 0 ? [] : await database.select().from(creatorPublicationMedia).where(inArray(creatorPublicationMedia.publicationShowcaseId, selected.map((item) => item.id))).orderBy(asc(creatorPublicationMedia.publicationShowcaseId), asc(creatorPublicationMedia.position));
      return { target, pageId: page.id, creatorUserId: page.userId, canonicalHandle: revision.canonicalHandle, displayName: revision.displayName, showcaseTitle: target.targetType === "showcase" ? selected[0]!.title : null, mediaAssetIds: unique([...(target.targetType === "page" ? [revision.avatarAssetId, revision.coverAssetId] : []), ...mediaRows.map((item) => item.assetId)]) };
    } catch { return null; }
  }
  return {
    async resolvePublicCreator(handle: string): Promise<PublicCreatorResolution> {
      if (input.publishingMode !== "general_audience" || !publicHandle(handle)) return { kind: "not_found" };
      const [claim] = await input.db.select().from(creatorHandleClaims).where(eq(creatorHandleClaims.normalizedHandle, handle)).limit(1);
      if (!claim) return { kind: "not_found" };
      const current = await loadEffective(input.db, claim.pageId);
      if (!current) return { kind: "not_found" };
      return claim.kind === "alias" ? { kind: "redirect", canonicalHandle: current.page.canonicalHandle } : { kind: "visible", page: current.page };
    },
    async listPublicCreators(query: DirectoryQuery): Promise<PublicCreatorDirectoryPage> {
      if (query.limit !== 24 || (query.discipline !== null && !isDiscipline(query.discipline)) || (query.handlePrefix !== "" && !HANDLE_PREFIX.test(query.handlePrefix))) throw new PublicCatalogQueryError("INVALID_QUERY");
      if (input.publishingMode !== "general_audience") return { items: [], nextCursor: null };
      let scan = query.cursor === null ? null : decodeCursor(query.cursor);
      const visible: PublicCreatorDirectoryItem[] = [];
      let scanned = 0;
      let exhausted = false;
      while (visible.length < 25 && scanned < PUBLIC_DIRECTORY_CANDIDATE_SCAN_BUDGET) {
        const batch = await candidates(input.db, { discipline: query.discipline, prefix: query.handlePrefix, after: scan });
        if (batch.length === 0) { exhausted = true; break; }
        scanned += batch.length;
        const evaluated = await loadEffectiveBatch(input.db, batch.map((item) => item.pageId));
        for (const candidate of batch) { const page = evaluated.get(candidate.pageId)?.page; if (!page || (query.discipline && page.primaryDiscipline !== query.discipline && !page.secondaryDisciplines.includes(query.discipline))) continue; visible.push({ pageId: page.pageId, canonicalHandle: page.canonicalHandle, displayName: page.displayName, introduction: page.introduction, disciplines: [page.primaryDiscipline, ...page.secondaryDisciplines], avatarThumbDerivativeId: page.avatar?.thumb.derivativeId ?? null }); if (visible.length === 25) break; }
        const last = batch.at(-1)!; scan = { handle: last.canonicalHandle, pageId: last.pageId };
        if (batch.length < PUBLIC_CATALOG_QUERY_BATCH_SIZE) { exhausted = true; break; }
      }
      const items = visible.slice(0, 24); const last = items.at(-1);
      const continuation = visible.length > 24 && last
        ? { handle: last.canonicalHandle, pageId: last.pageId }
        : !exhausted && scanned >= PUBLIC_DIRECTORY_CANDIDATE_SCAN_BUDGET ? scan : null;
      return { items, nextCursor: continuation ? encodeCursor(continuation.handle, continuation.pageId) : null };
    },
    async listSitemapCreators(): Promise<readonly string[]> {
      if (input.publishingMode !== "general_audience") return [];
      let scan: { handle: string; pageId: string } | null = null; const handles: string[] = [];
      for (;;) { const batch = await candidates(input.db, { after: scan }); if (batch.length === 0) break; const evaluated = await loadEffectiveBatch(input.db, batch.map((item) => item.pageId)); for (const item of batch) { const page = evaluated.get(item.pageId)?.page; if (page) handles.push(page.canonicalHandle); } const last = batch.at(-1)!; scan = { handle: last.canonicalHandle, pageId: last.pageId }; if (batch.length < PUBLIC_CATALOG_QUERY_BATCH_SIZE) break; }
      return handles;
    },
    async isDerivativePublic(database: Database, assetId: string, variant: Variant): Promise<boolean> {
      if (!isUuid(assetId) || !isVariant(variant) || input.publishingMode !== "general_audience") return false;
      try {
        const pageIds = new Set<string>();
        if (variant !== "large") {
          const rows = await database.select({ pageId: creatorPages.id, avatar: creatorPublicationRevisions.avatarAssetId, cover: creatorPublicationRevisions.coverAssetId }).from(creatorPages).innerJoin(creatorPublicationRevisions, and(eq(creatorPublicationRevisions.id, creatorPages.publishedRevisionId), eq(creatorPublicationRevisions.pageId, creatorPages.id))).where(variant === "thumb" ? eq(creatorPublicationRevisions.avatarAssetId, assetId) : or(eq(creatorPublicationRevisions.avatarAssetId, assetId), eq(creatorPublicationRevisions.coverAssetId, assetId))!);
          for (const row of rows) if ((row.avatar === assetId && (variant === "thumb" || variant === "display")) || (row.cover === assetId && variant === "display")) pageIds.add(row.pageId);
        }
        const rows = await database.select({ pageId: creatorPages.id }).from(creatorPublicationMedia).innerJoin(creatorPublicationShowcases, eq(creatorPublicationShowcases.id, creatorPublicationMedia.publicationShowcaseId)).innerJoin(creatorPublicationRevisions, eq(creatorPublicationRevisions.id, creatorPublicationShowcases.revisionId)).innerJoin(creatorPages, and(eq(creatorPages.id, creatorPublicationRevisions.pageId), eq(creatorPages.publishedRevisionId, creatorPublicationRevisions.id))).where(eq(creatorPublicationMedia.assetId, assetId));
        for (const row of rows) pageIds.add(row.pageId);
        if (pageIds.size === 0) return false;
        const evaluated = await loadEffectiveBatch(database, [...pageIds]);
        return [...evaluated.values()].some(({ page }) => (page.avatar?.assetId === assetId && (variant === "thumb" || variant === "display")) || (page.cover?.assetId === assetId && variant === "display") || page.showcases.some((showcase) => showcase.media.some((item) => item.assetId === assetId)));
      } catch { return false; }
    },
    async isDerivativePreviewable(database: Database, actorUserId: string, assetId: string, variant: Variant): Promise<boolean> {
      if (!isUuid(assetId) || !isVariant(variant)) return false;
      try {
        const seed = await input.creatorSeeds.getCreatorSeed(database, actorUserId); if (!seed || seed.userId !== actorUserId) return false;
        const [page] = await database.select().from(creatorPages).where(eq(creatorPages.userId, actorUserId)).limit(1); if (!page) return false;
        const [draft] = await database.select().from(creatorPageDrafts).where(eq(creatorPageDrafts.pageId, page.id)).limit(1); if (!draft) return false;
        const references: MediaReference[] = [];
        if (draft.avatarAssetId === assetId) references.push({ assetId, purpose: "avatar", altText: null });
        if (draft.coverAssetId === assetId) references.push({ assetId, purpose: "cover", altText: null });
        const showcases = await database.select({ id: creatorShowcaseDrafts.id }).from(creatorShowcaseDrafts).where(and(eq(creatorShowcaseDrafts.pageId, page.id), isNull(creatorShowcaseDrafts.removedAt)));
        if (showcases.length > 0) { const [row] = await database.select().from(creatorShowcaseDraftMedia).where(and(inArray(creatorShowcaseDraftMedia.showcaseId, showcases.map((item) => item.id)), eq(creatorShowcaseDraftMedia.assetId, assetId))).limit(1); if (row) references.push({ assetId, purpose: "showcase", altText: row.alternativeText }); }
        if (references.length !== 1) return false;
        const resolved = exactMap(await input.mediaCatalog.resolveReadyAssets(database, actorUserId, references), [assetId]); const reference = references[0]!;
        return Boolean(resolved && exactMedia(reference, resolved.get(assetId), actorUserId));
      } catch { return false; }
    },
    resolveVisibleReportTarget(database: Database, target: ReportTarget) { return snapshot(database, target, true); },
    readRevisionTarget(database: Database, target: ReportTarget) { return snapshot(database, target, false); },
  };
}
