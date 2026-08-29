import { Buffer } from "node:buffer";

import {
  creatorDiscoveryProjections,
  creatorHandleClaims,
  creatorPageDrafts,
  creatorPages,
  creatorPublicationMedia,
  creatorPublicationRevisions,
  creatorPublicationShowcases,
  creatorShowcaseDraftMedia,
  creatorShowcaseDrafts,
  type PawketDatabase,
  type PawketTransaction,
} from "@pawket/database";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { CONTENT_POLICY_VERSION, DISCIPLINES, TAXONOMY_VERSION, type Discipline } from "./catalog-policy.js";
import type { IdentityCreatorSeedPort, MediaCatalogPort, MediaReference, ReadyMedia, VisibilityReadPort } from "./catalog-ports.js";

export type PublicDerivative = Readonly<{
  derivativeId: string;
  width: number;
  height: number;
}>;

export type PublicCreatorMedia = Readonly<{
  assetId: string;
  thumbDerivativeId: string;
  displayDerivativeId: string;
  largeDerivativeId: string;
  alternativeText: string;
  dimensions: Readonly<Record<"thumb" | "display" | "large", Readonly<{ width: number; height: number }>>>;
}>;

export type PublicCreatorShowcase = Readonly<{
  sourceShowcaseId: string;
  position: number;
  title: string;
  description: string;
  discipline: Discipline;
  contentLabel: "general_audience";
  externalUrl: string | null;
  media: readonly PublicCreatorMedia[];
}>;

export type PublicCreatorPage = Readonly<{
  pageId: string;
  revisionId: string;
  revisionNumber: number;
  canonicalHandle: string;
  displayName: string;
  introduction: string;
  primaryDiscipline: Discipline;
  secondaryDisciplines: readonly Discipline[];
  avatar: Readonly<{ assetId: string; thumb: PublicDerivative; display: PublicDerivative }> | null;
  cover: Readonly<{ assetId: string; display: PublicDerivative }> | null;
  showcases: readonly PublicCreatorShowcase[];
  publishedAt: Date;
}>;

export type PublicCreatorResolution =
  | { kind: "not_found" }
  | { kind: "redirect"; canonicalHandle: string }
  | { kind: "visible"; page: PublicCreatorPage };

export type DirectoryQuery = Readonly<{
  discipline: Discipline | null;
  handlePrefix: string;
  cursor: string | null;
  limit: 24;
}>;

export type PublicCreatorDirectoryItem = Readonly<{
  pageId: string;
  canonicalHandle: string;
  displayName: string;
  introduction: string;
  disciplines: readonly Discipline[];
  avatarThumbDerivativeId: string | null;
}>;

export type PublicCreatorDirectoryPage = Readonly<{
  items: readonly PublicCreatorDirectoryItem[];
  nextCursor: string | null;
}>;

export type ReportTarget = Readonly<{
  targetType: "page" | "showcase";
  targetId: string;
  publicationRevisionId: string;
}>;

export type ModerationTargetSnapshot = Readonly<{
  target: ReportTarget;
  pageId: string;
  mediaAssetIds: readonly string[];
}>;

type PublicCatalogQueryInput = Readonly<{
  db: PawketDatabase;
  creatorSeeds: IdentityCreatorSeedPort;
  mediaCatalog: MediaCatalogPort;
  visibility: VisibilityReadPort;
  publishingMode: "disabled" | "general_audience";
}>;

type Database = PawketDatabase | PawketTransaction;
type Variant = "thumb" | "display" | "large";

export class PublicCatalogQueryError extends Error {
  constructor(readonly code: "INVALID_QUERY" | "INVALID_CURSOR") {
    super(code);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PUBLIC_HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const HANDLE_PREFIX = /^[a-z0-9-]{1,30}$/u;

function isUuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
function isDiscipline(value: unknown): value is Discipline { return typeof value === "string" && (DISCIPLINES as readonly string[]).includes(value); }
function isVariant(value: unknown): value is Variant { return value === "thumb" || value === "display" || value === "large"; }

function publicHandle(value: unknown): value is string {
  return typeof value === "string" && value.length >= 3 && value.length <= 30 && PUBLIC_HANDLE.test(value);
}

function encodeCursor(handle: string, pageId: string): string {
  return Buffer.from(JSON.stringify(["v1", handle, pageId]), "utf8").toString("base64url");
}

function decodeCursor(value: string): { handle: string; pageId: string } {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(decoded) || decoded.length !== 3 || decoded[0] !== "v1" || !publicHandle(decoded[1]) || !isUuid(decoded[2])) throw new Error("invalid");
    if (encodeCursor(decoded[1], decoded[2]) !== value) throw new Error("non-canonical");
    return { handle: decoded[1], pageId: decoded[2] };
  } catch {
    throw new PublicCatalogQueryError("INVALID_CURSOR");
  }
}

function exactMedia(reference: MediaReference, item: ReadyMedia | undefined, ownerUserId: string): ReadyMedia | null {
  if (!item || item.assetId !== reference.assetId || item.ownerUserId !== ownerUserId || item.purpose !== reference.purpose) return null;
  for (const derivative of Object.values(item.derivatives)) {
    if (!isUuid(derivative.derivativeId) || !Number.isInteger(derivative.width) || derivative.width <= 0 || !Number.isInteger(derivative.height) || derivative.height <= 0) return null;
  }
  return item;
}

function derivative(item: ReadyMedia, variant: Variant): PublicDerivative {
  const value = item.derivatives[variant];
  return { derivativeId: value.derivativeId, width: value.width, height: value.height };
}

export function createPublicCatalogQuery(input: PublicCatalogQueryInput) {
  async function loadEffective(database: Database, pageId: string): Promise<PublicCreatorPage | null> {
    if (input.publishingMode !== "general_audience" || !isUuid(pageId)) return null;
    const [page] = await database.select().from(creatorPages).where(eq(creatorPages.id, pageId)).limit(1);
    if (!page?.publishedRevisionId) return null;
    const seed = await input.creatorSeeds.getCreatorSeed(database, page.userId);
    if (!seed || seed.userId !== page.userId || seed.capabilityState !== "active") return null;
    const [projection] = await database.select().from(creatorDiscoveryProjections).where(eq(creatorDiscoveryProjections.pageId, page.id)).limit(1);
    if (!projection || projection.enabled !== true || projection.revisionId !== page.publishedRevisionId) return null;
    const [revision] = await database.select().from(creatorPublicationRevisions).where(and(eq(creatorPublicationRevisions.id, page.publishedRevisionId), eq(creatorPublicationRevisions.pageId, page.id))).limit(1);
    if (!revision || revision.taxonomyVersion !== TAXONOMY_VERSION || revision.policyVersion !== CONTENT_POLICY_VERSION) return null;
    if (!isDiscipline(revision.primaryDiscipline) || !revision.secondaryDisciplines.every(isDiscipline)) return null;
    const [canonical] = await database.select().from(creatorHandleClaims).where(and(eq(creatorHandleClaims.pageId, page.id), eq(creatorHandleClaims.kind, "canonical"))).limit(1);
    if (!canonical || !publicHandle(canonical.normalizedHandle) || projection.canonicalHandle !== canonical.normalizedHandle) return null;
    const [publishedIdentity] = await database.select({ id: creatorHandleClaims.id }).from(creatorHandleClaims).where(and(eq(creatorHandleClaims.pageId, page.id), eq(creatorHandleClaims.normalizedHandle, revision.canonicalHandle))).limit(1);
    if (!publishedIdentity) return null;
    const showcases = await database.select().from(creatorPublicationShowcases).where(eq(creatorPublicationShowcases.revisionId, revision.id)).orderBy(asc(creatorPublicationShowcases.position));
    const holds = await input.visibility.readHolds(database, page.id, revision.id, showcases.map((showcase) => showcase.sourceShowcaseId));
    if (holds.pageHeld) return null;
    const visibleShowcases = showcases.filter((showcase) => !holds.heldShowcaseIds.has(showcase.sourceShowcaseId));
    if (visibleShowcases.some((showcase) => !isDiscipline(showcase.discipline) || showcase.contentLabel !== "general_audience")) return null;
    const publicationShowcaseIds = visibleShowcases.map((showcase) => showcase.id);
    const mediaRows = publicationShowcaseIds.length === 0
      ? []
      : await database.select().from(creatorPublicationMedia).where(inArray(creatorPublicationMedia.publicationShowcaseId, publicationShowcaseIds)).orderBy(asc(creatorPublicationMedia.position));
    const references: MediaReference[] = [];
    if (revision.avatarAssetId) references.push({ assetId: revision.avatarAssetId, purpose: "avatar", altText: null });
    if (revision.coverAssetId) references.push({ assetId: revision.coverAssetId, purpose: "cover", altText: null });
    for (const mediaRow of mediaRows) references.push({ assetId: mediaRow.assetId, purpose: "showcase", altText: mediaRow.alternativeText });
    const resolved = await input.mediaCatalog.resolveReadyAssets(database, page.userId, references);
    const ready = new Map<string, ReadyMedia>();
    for (const reference of references) {
      const item = exactMedia(reference, resolved.get(reference.assetId), page.userId);
      if (!item) return null;
      ready.set(reference.assetId, item);
    }
    const avatarMedia = revision.avatarAssetId ? ready.get(revision.avatarAssetId) : undefined;
    const coverMedia = revision.coverAssetId ? ready.get(revision.coverAssetId) : undefined;
    if (avatarMedia && (avatarMedia.derivatives.thumb.derivativeId !== revision.avatarThumbDerivativeId || avatarMedia.derivatives.display.derivativeId !== revision.avatarDisplayDerivativeId)) return null;
    if (coverMedia && coverMedia.derivatives.display.derivativeId !== revision.coverDisplayDerivativeId) return null;
    const projectedShowcases: PublicCreatorShowcase[] = [];
    for (const showcase of visibleShowcases) {
      const projectedMedia: PublicCreatorMedia[] = [];
      for (const row of mediaRows.filter((item) => item.publicationShowcaseId === showcase.id)) {
        const item = ready.get(row.assetId);
        if (!item || item.derivatives.thumb.derivativeId !== row.thumbDerivativeId || item.derivatives.display.derivativeId !== row.displayDerivativeId || item.derivatives.large.derivativeId !== row.largeDerivativeId) return null;
        projectedMedia.push({
          assetId: row.assetId,
          thumbDerivativeId: row.thumbDerivativeId,
          displayDerivativeId: row.displayDerivativeId,
          largeDerivativeId: row.largeDerivativeId,
          alternativeText: row.alternativeText,
          dimensions: {
            thumb: { width: item.derivatives.thumb.width, height: item.derivatives.thumb.height },
            display: { width: item.derivatives.display.width, height: item.derivatives.display.height },
            large: { width: item.derivatives.large.width, height: item.derivatives.large.height },
          },
        });
      }
      projectedShowcases.push({
        sourceShowcaseId: showcase.sourceShowcaseId,
        position: showcase.position,
        title: showcase.title,
        description: showcase.description,
        discipline: showcase.discipline as Discipline,
        contentLabel: "general_audience",
        externalUrl: showcase.externalUrl,
        media: projectedMedia,
      });
    }
    return {
      pageId: page.id,
      revisionId: revision.id,
      revisionNumber: revision.revisionNumber,
      canonicalHandle: canonical.normalizedHandle,
      displayName: revision.displayName,
      introduction: revision.shortIntroduction,
      primaryDiscipline: revision.primaryDiscipline,
      secondaryDisciplines: revision.secondaryDisciplines,
      avatar: avatarMedia ? { assetId: avatarMedia.assetId, thumb: derivative(avatarMedia, "thumb"), display: derivative(avatarMedia, "display") } : null,
      cover: coverMedia ? { assetId: coverMedia.assetId, display: derivative(coverMedia, "display") } : null,
      showcases: projectedShowcases,
      publishedAt: revision.publishedAt,
    };
  }

  async function visibleCandidates(database: Database, query?: { discipline?: Discipline | null; prefix?: string }) {
    const predicates = [eq(creatorDiscoveryProjections.enabled, true)];
    if (query?.discipline) predicates.push(sql`${query.discipline} = any(${creatorDiscoveryProjections.disciplines})`);
    if (query?.prefix) predicates.push(sql`${creatorDiscoveryProjections.canonicalHandle} like ${`${query.prefix}%`}`);
    return database.select({ pageId: creatorDiscoveryProjections.pageId, canonicalHandle: creatorDiscoveryProjections.canonicalHandle }).from(creatorDiscoveryProjections).where(and(...predicates)).orderBy(asc(creatorDiscoveryProjections.canonicalHandle), asc(creatorDiscoveryProjections.pageId));
  }

  async function snapshotForTarget(database: Database, target: ReportTarget, requireVisible: boolean): Promise<ModerationTargetSnapshot | null> {
    if (!isUuid(target.targetId) || !isUuid(target.publicationRevisionId) || (target.targetType !== "page" && target.targetType !== "showcase")) return null;
    const [revision] = await database.select().from(creatorPublicationRevisions).where(eq(creatorPublicationRevisions.id, target.publicationRevisionId)).limit(1);
    if (!revision) return null;
    const [page] = await database.select().from(creatorPages).where(eq(creatorPages.id, revision.pageId)).limit(1);
    if (!page) return null;
    if (requireVisible) {
      const visible = await loadEffective(database, page.id);
      if (!visible || visible.revisionId !== target.publicationRevisionId) return null;
      if (target.targetType === "showcase" && !visible.showcases.some((showcase) => showcase.sourceShowcaseId === target.targetId)) return null;
      if (target.targetType === "page" && target.targetId !== page.id) return null;
    }
    const showcases = await database.select().from(creatorPublicationShowcases).where(eq(creatorPublicationShowcases.revisionId, revision.id));
    const selected = target.targetType === "showcase" ? showcases.filter((showcase) => showcase.sourceShowcaseId === target.targetId) : showcases;
    if (target.targetType === "showcase" && selected.length !== 1) return null;
    if (target.targetType === "page" && target.targetId !== page.id) return null;
    const selectedIds = selected.map((showcase) => showcase.id);
    const mediaRows = selectedIds.length === 0 ? [] : await database.select({ assetId: creatorPublicationMedia.assetId }).from(creatorPublicationMedia).where(inArray(creatorPublicationMedia.publicationShowcaseId, selectedIds));
    const assetIds = [revision.avatarAssetId, revision.coverAssetId, ...mediaRows.map((item) => item.assetId)].filter((value): value is string => value !== null);
    return { target, pageId: page.id, mediaAssetIds: [...new Set(assetIds)] };
  }

  return {
    async resolvePublicCreator(handle: string): Promise<PublicCreatorResolution> {
      if (input.publishingMode !== "general_audience" || !publicHandle(handle)) return { kind: "not_found" };
      const [claim] = await input.db.select().from(creatorHandleClaims).where(eq(creatorHandleClaims.normalizedHandle, handle)).limit(1);
      if (!claim) return { kind: "not_found" };
      const page = await loadEffective(input.db, claim.pageId);
      if (!page) return { kind: "not_found" };
      return claim.kind === "alias" ? { kind: "redirect", canonicalHandle: page.canonicalHandle } : { kind: "visible", page };
    },
    async listPublicCreators(query: DirectoryQuery): Promise<PublicCreatorDirectoryPage> {
      if (query.limit !== 24 || (query.discipline !== null && !isDiscipline(query.discipline)) || (query.handlePrefix !== "" && !HANDLE_PREFIX.test(query.handlePrefix))) throw new PublicCatalogQueryError("INVALID_QUERY");
      if (input.publishingMode !== "general_audience") return { items: [], nextCursor: null };
      const cursor = query.cursor === null ? null : decodeCursor(query.cursor);
      const candidates = await visibleCandidates(input.db, { discipline: query.discipline, prefix: query.handlePrefix });
      const afterCursor = candidates.filter((candidate) => !cursor || candidate.canonicalHandle > cursor.handle || (candidate.canonicalHandle === cursor.handle && candidate.pageId > cursor.pageId));
      const visible: PublicCreatorDirectoryItem[] = [];
      for (const candidate of afterCursor) {
        const page = await loadEffective(input.db, candidate.pageId);
        if (!page || (query.discipline && page.primaryDiscipline !== query.discipline && !page.secondaryDisciplines.includes(query.discipline))) continue;
        visible.push({ pageId: page.pageId, canonicalHandle: page.canonicalHandle, displayName: page.displayName, introduction: page.introduction, disciplines: [page.primaryDiscipline, ...page.secondaryDisciplines], avatarThumbDerivativeId: page.avatar?.thumb.derivativeId ?? null });
        if (visible.length === 25) break;
      }
      const items = visible.slice(0, 24);
      const last = items.at(-1);
      return { items, nextCursor: visible.length > 24 && last ? encodeCursor(last.canonicalHandle, last.pageId) : null };
    },
    async listSitemapCreators(): Promise<readonly string[]> {
      if (input.publishingMode !== "general_audience") return [];
      const candidates = await visibleCandidates(input.db);
      const handles: string[] = [];
      for (const candidate of candidates) {
        const page = await loadEffective(input.db, candidate.pageId);
        if (page) handles.push(page.canonicalHandle);
      }
      return handles;
    },
    async isDerivativePublic(database: Database, assetId: string, variant: Variant): Promise<boolean> {
      if (!isUuid(assetId) || !isVariant(variant)) return false;
      const candidates = await visibleCandidates(database);
      for (const candidate of candidates) {
        const page = await loadEffective(database, candidate.pageId);
        if (!page) continue;
        if (page.avatar?.assetId === assetId && (variant === "thumb" || variant === "display")) return true;
        if (page.cover?.assetId === assetId && variant === "display") return true;
        if (page.showcases.some((showcase) => showcase.media.some((item) => item.assetId === assetId))) return true;
      }
      return false;
    },
    async isDerivativePreviewable(database: Database, actorUserId: string, assetId: string, variant: Variant): Promise<boolean> {
      if (!isUuid(assetId) || !isVariant(variant)) return false;
      const seed = await input.creatorSeeds.getCreatorSeed(database, actorUserId);
      if (!seed || seed.userId !== actorUserId) return false;
      const [page] = await database.select().from(creatorPages).where(eq(creatorPages.userId, actorUserId)).limit(1);
      if (!page) return false;
      const [draft] = await database.select().from(creatorPageDrafts).where(eq(creatorPageDrafts.pageId, page.id)).limit(1);
      if (!draft) return false;
      const references: MediaReference[] = [];
      if (draft.avatarAssetId === assetId) references.push({ assetId, purpose: "avatar", altText: null });
      if (draft.coverAssetId === assetId) references.push({ assetId, purpose: "cover", altText: null });
      const showcases = await database.select({ id: creatorShowcaseDrafts.id }).from(creatorShowcaseDrafts).where(and(eq(creatorShowcaseDrafts.pageId, page.id), isNull(creatorShowcaseDrafts.removedAt)));
      if (showcases.length > 0) {
        const [showcaseMedia] = await database.select().from(creatorShowcaseDraftMedia).where(and(inArray(creatorShowcaseDraftMedia.showcaseId, showcases.map((showcase) => showcase.id)), eq(creatorShowcaseDraftMedia.assetId, assetId))).limit(1);
        if (showcaseMedia) references.push({ assetId, purpose: "showcase", altText: showcaseMedia.alternativeText });
      }
      if (references.length !== 1) return false;
      const reference = references[0]!;
      if ((reference.purpose === "avatar" && variant === "large") || (reference.purpose === "cover" && variant !== "display")) return false;
      const resolved = await input.mediaCatalog.resolveReadyAssets(database, actorUserId, references);
      return exactMedia(reference, resolved.get(assetId), actorUserId) !== null;
    },
    resolveVisibleReportTarget(database: Database, target: ReportTarget) { return snapshotForTarget(database, target, true); },
    readRevisionTarget(database: Database, target: ReportTarget) { return snapshotForTarget(database, target, false); },
  };
}
