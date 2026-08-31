import { randomUUID } from "node:crypto";

import {
  acquirePublicMediaRetentionFences,
  beginIdempotentCommand,
  completeIdempotentCommand,
  creatorDiscoveryProjections,
  creatorHandleClaims,
  creatorPageDrafts,
  creatorPages,
  creatorPublicationEvents,
  creatorPublicationMedia,
  creatorPublicationRevisions,
  creatorPublicationShowcases,
  creatorShowcaseDraftMedia,
  creatorShowcaseDrafts,
  insertOutboxEvent,
  type PawketDatabase,
  type PawketTransaction,
} from "@pawket/database";
import { createLookupHmac } from "@pawket/security";
import { and, asc, eq, inArray, isNull, max, sql } from "drizzle-orm";

import {
  CatalogPolicyError,
  CONTENT_POLICY_VERSION,
  DISCIPLINES,
  normalizeExternalDestination,
  normalizeHandle,
  normalizeProfileText,
  TAXONOMY_VERSION,
  type Discipline,
} from "./catalog-policy.js";
import type { CreatorSeed, IdentityCreatorSeedPort, MediaCatalogPort, MediaReference, ReadyMedia, VisibilityReadPort } from "./catalog-ports.js";
import { readExactNativeMap, readExactNativeStringSet, readExactOwnRecord } from "./runtime-boundary.js";

export const HANDLE_RECENT_AUTH_MS = 15 * 60_000;
export const HANDLE_RENAME_COOLDOWN_MS = 30 * 24 * 60 * 60_000;
const IDEMPOTENCY_LIFETIME_MS = 24 * 60 * 60_000;

export type CatalogActor = Readonly<{ userId: string; sessionId: string; primaryAuthenticatedAt: Date }>;
export type CatalogWorkspace = Readonly<{
  pageId: string;
  draftVersion: number;
  publishedRevisionId: string | null;
  canonicalHandle: string | null;
  aliases: readonly string[];
  renameAvailableAt: Date | null;
  draft: Readonly<{
    displayName: string;
    introduction: string;
    primaryDiscipline: string;
    secondaryDisciplines: readonly string[];
    avatarAssetId: string | null;
    coverAssetId: string | null;
  }>;
  showcases: readonly Readonly<{
    id: string;
    position: number;
    title: string;
    description: string;
    discipline: string;
    contentLabel: "general_audience";
    externalUrl: string | null;
    media: readonly Readonly<{ assetId: string; alternativeText: string; position: number }>[];
  }>[];
  capabilityState: "active" | "suspended";
  enforcement: Readonly<{ pageHeld: boolean; heldShowcaseIds: readonly string[] }>;
}>;
export type VersionedCatalogCommand = Readonly<{
  actor: CatalogActor;
  pageId: string;
  expectedVersion: number;
  idempotencyKey: string;
  requestId: string;
}>;

type DraftInput = Readonly<{
  displayName: unknown;
  introduction: unknown;
  primaryDiscipline: unknown;
  secondaryDisciplines: unknown;
  avatarAssetId: string | null;
  coverAssetId: string | null;
}>;
type ShowcaseInput = Readonly<{
  id?: string;
  position: unknown;
  title: unknown;
  description: unknown;
  discipline: unknown;
  contentLabel: unknown;
  externalUrl: unknown;
  media: readonly Readonly<{ assetId: unknown; alternativeText: unknown }>[];
}>;
type CatalogServiceInput = Readonly<{
  db: PawketDatabase;
  creatorSeeds: IdentityCreatorSeedPort;
  mediaCatalog?: MediaCatalogPort;
  visibility?: VisibilityReadPort;
  publishingMode: "disabled" | "general_audience";
  commandFingerprintKey: Uint8Array;
  now?: () => Date;
  idFactory?: () => string;
}>;

export type PublishResult = Readonly<{
  pageId: string;
  revisionId: string;
  revisionNumber: number;
  canonicalHandle: string;
  draftVersion: number;
  publishedAt: Date;
}>;

export type UnpublishResult = Readonly<{
  pageId: string;
  previousPublishedRevisionId: string;
  draftVersion: number;
  unpublishedAt: Date;
}>;

export type SuspensionPublicationClear = Readonly<{
  creatorUserId: string;
  actorUserId: string;
  actorSessionId: string;
  reasonCode: string;
  requestId: string;
  occurredAt: Date;
}>;

export class CatalogServiceError extends Error {
  constructor(readonly code: "NOT_FOUND" | "VERSION_CONFLICT" | "IDEMPOTENCY_CONFLICT" | "HANDLE_UNAVAILABLE" | "RECENT_AUTH_REQUIRED" | "RENAME_COOLDOWN" | "POLICY_VIOLATION" | "PUBLISHING_DISABLED") {
    super(code);
  }
}

function fail(code: CatalogServiceError["code"]): never { throw new CatalogServiceError(code); }
function policy(condition: unknown): asserts condition { if (!condition) fail("POLICY_VIOLATION"); }
function validIdempotencyKey(value: string): boolean { return /^[A-Za-z0-9._-]{8,200}$/u.test(value); }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function validUuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
function validRequestId(value: string): boolean { return /^[A-Za-z0-9._:-]{1,200}$/u.test(value); }
function isDiscipline(value: unknown): value is Discipline { return typeof value === "string" && (DISCIPLINES as readonly string[]).includes(value); }
function databaseConstraint(error: unknown, constraint: string): boolean {
  let current = error;
  while (current && typeof current === "object") {
    const candidate = current as { code?: unknown; constraint_name?: unknown; cause?: unknown };
    if (candidate.code === "23505" && candidate.constraint_name === constraint) return true;
    current = candidate.cause;
  }
  return false;
}
function replayReference(pageId: string, version: number): string { return `catalog-v1:${pageId}:${version}`; }
function parseReplayReference(value: string): { pageId: string; version: number } | null {
  const match = /^catalog-v1:([0-9a-f-]{36}):([1-9]\d*)$/u.exec(value);
  return match ? { pageId: match[1]!, version: Number(match[2]) } : null;
}

function publicationReplayReference(result: PublishResult): string {
  return ["catalog-publish-v1", result.pageId, result.revisionId, result.revisionNumber, result.canonicalHandle, result.draftVersion, result.publishedAt.getTime()].join(":");
}

function parsePublicationReplayReference(value: string): PublishResult | null {
  const match = /^catalog-publish-v1:([0-9a-f-]{36}):([0-9a-f-]{36}):([1-9]\d*):([a-z0-9-]{3,30}):([1-9]\d*):(\d+)$/u.exec(value);
  if (!match) return null;
  const publishedAt = new Date(Number(match[6]));
  if (Number.isNaN(publishedAt.getTime())) return null;
  return { pageId: match[1]!, revisionId: match[2]!, revisionNumber: Number(match[3]), canonicalHandle: match[4]!, draftVersion: Number(match[5]), publishedAt };
}

function unpublicationReplayReference(result: UnpublishResult): string {
  return ["catalog-unpublish-v1", result.pageId, result.previousPublishedRevisionId, result.draftVersion, result.unpublishedAt.getTime()].join(":");
}

function parseUnpublicationReplayReference(value: string): UnpublishResult | null {
  const match = /^catalog-unpublish-v1:([0-9a-f-]{36}):([0-9a-f-]{36}):([1-9]\d*):(\d+)$/u.exec(value);
  if (!match) return null;
  const unpublishedAt = new Date(Number(match[4]));
  if (Number.isNaN(unpublishedAt.getTime())) return null;
  return { pageId: match[1]!, previousPublishedRevisionId: match[2]!, draftVersion: Number(match[3]), unpublishedAt };
}

function assertReadyReference(reference: MediaReference, resolved: ReadyMedia | undefined, ownerUserId: string): ReadyMedia {
  const media = readExactOwnRecord(resolved, ["assetId", "ownerUserId", "purpose", "derivatives"]);
  if (!media || media.assetId !== reference.assetId || media.ownerUserId !== ownerUserId || media.purpose !== reference.purpose) fail("POLICY_VIOLATION");
  const derivatives = readExactOwnRecord(media.derivatives, ["thumb", "display", "large"]);
  if (!derivatives) fail("POLICY_VIOLATION");
  const normalized = {} as Record<"thumb" | "display" | "large", ReadyMedia["derivatives"]["thumb"]>;
  for (const variant of ["thumb", "display", "large"] as const) {
    const candidate = readExactOwnRecord(derivatives[variant], ["derivativeId", "width", "height"]);
    if (!candidate || !validUuid(candidate.derivativeId) || !Number.isInteger(candidate.width) || (candidate.width as number) <= 0 || !Number.isInteger(candidate.height) || (candidate.height as number) <= 0) fail("POLICY_VIOLATION");
    normalized[variant] = { derivativeId: candidate.derivativeId, width: candidate.width as number, height: candidate.height as number };
  }
  return { assetId: reference.assetId, ownerUserId, purpose: reference.purpose, derivatives: normalized };
}

function exactReadyMap(references: readonly MediaReference[], resolved: unknown, ownerUserId: string): ReadonlyMap<string, ReadyMedia> {
  const expectedIds = [...new Set(references.map((reference) => reference.assetId))];
  const safe = readExactNativeMap(resolved, expectedIds);
  if (!safe) fail("POLICY_VIOLATION");
  const result = new Map<string, ReadyMedia>();
  for (const reference of references) result.set(reference.assetId, assertReadyReference(reference, safe.get(reference.assetId) as ReadyMedia | undefined, ownerUserId));
  return result;
}

function exactCreatorSeed(value: unknown, userId: string): CreatorSeed | null {
  const seed = readExactOwnRecord(value, ["userId", "capabilityState", "capabilityVersion", "approvedRevisionId", "displayName", "introduction"]);
  if (!seed || seed.userId !== userId || (seed.capabilityState !== "active" && seed.capabilityState !== "suspended")
    || !Number.isInteger(seed.capabilityVersion) || (seed.capabilityVersion as number) <= 0 || !validUuid(seed.approvedRevisionId)
    || typeof seed.displayName !== "string" || typeof seed.introduction !== "string") return null;
  return { userId, capabilityState: seed.capabilityState, capabilityVersion: seed.capabilityVersion as number, approvedRevisionId: seed.approvedRevisionId, displayName: seed.displayName, introduction: seed.introduction };
}

function exactHolds(value: unknown, showcaseIds: readonly string[]): { pageHeld: boolean; heldShowcaseIds: Set<string> } | null {
  const holds = readExactOwnRecord(value, ["pageHeld", "heldShowcaseIds"]);
  if (!holds || typeof holds.pageHeld !== "boolean") return null;
  const heldShowcaseIds = readExactNativeStringSet(holds.heldShowcaseIds);
  if (!heldShowcaseIds || [...heldShowcaseIds].some((showcaseId) => !showcaseIds.includes(showcaseId))) return null;
  return { pageHeld: holds.pageHeld, heldShowcaseIds };
}

function normalizeDraft(input: DraftInput) {
  policy(isDiscipline(input.primaryDiscipline));
  policy(Array.isArray(input.secondaryDisciplines) && input.secondaryDisciplines.length <= 2);
  const secondary = input.secondaryDisciplines as unknown[];
  policy(secondary.every(isDiscipline) && !secondary.includes(input.primaryDiscipline) && new Set(secondary).size === secondary.length);
  policy(input.avatarAssetId === null || typeof input.avatarAssetId === "string");
  policy(input.coverAssetId === null || typeof input.coverAssetId === "string");
  policy(input.avatarAssetId === null || validUuid(input.avatarAssetId));
  policy(input.coverAssetId === null || validUuid(input.coverAssetId));
  try {
    return {
      displayName: normalizeProfileText(input.displayName, { minCodePoints: 1, maxCodePoints: 80 }),
      introduction: normalizeProfileText(input.introduction, { minCodePoints: 1, maxCodePoints: 500 }),
      primaryDiscipline: input.primaryDiscipline,
      secondaryDisciplines: secondary as string[],
      avatarAssetId: input.avatarAssetId,
      coverAssetId: input.coverAssetId,
    };
  } catch (error) {
    if (error instanceof CatalogPolicyError) fail("POLICY_VIOLATION");
    throw error;
  }
}

function normalizeShowcase(input: ShowcaseInput) {
  policy(Number.isInteger(input.position) && (input.position as number) >= 0 && (input.position as number) <= 11);
  policy(isDiscipline(input.discipline) && input.contentLabel === "general_audience");
  policy(Array.isArray(input.media) && input.media.length <= 4);
  try {
    const media = input.media.map((item) => {
      policy(validUuid(item.assetId));
      return { assetId: item.assetId, alternativeText: normalizeProfileText(item.alternativeText, { minCodePoints: 1, maxCodePoints: 300 }) };
    });
    return {
      id: input.id,
      position: input.position as number,
      title: normalizeProfileText(input.title, { minCodePoints: 1, maxCodePoints: 100 }),
      description: normalizeProfileText(input.description, { minCodePoints: 0, maxCodePoints: 1_000 }),
      discipline: input.discipline,
      contentLabel: "general_audience" as const,
      externalUrl: input.externalUrl === null || input.externalUrl === undefined ? null : normalizeExternalDestination(input.externalUrl),
      media,
    };
  } catch (error) {
    if (error instanceof CatalogPolicyError) fail("POLICY_VIOLATION");
    throw error;
  }
}

export function createCatalogService(input: CatalogServiceInput) {
  const now = input.now ?? (() => new Date());
  const id = input.idFactory ?? randomUUID;

  async function requireCreator(database: PawketDatabase | PawketTransaction, userId: string, activeOnly: boolean) {
    const seed = exactCreatorSeed(await input.creatorSeeds.getCreatorSeed(database, userId), userId);
    if (!seed || (activeOnly && seed.capabilityState !== "active")) fail("NOT_FOUND");
    return seed;
  }

  async function lockOwnedPage(tx: PawketTransaction, userId: string, pageId: string) {
    const [page] = await tx.select().from(creatorPages).where(and(eq(creatorPages.id, pageId), eq(creatorPages.userId, userId))).limit(1).for("update");
    if (!page) fail("NOT_FOUND");
    return page;
  }

  async function validateNewMediaReferences(
    tx: PawketTransaction,
    ownerUserId: string,
    references: readonly MediaReference[],
  ): Promise<void> {
    if (references.length === 0) return;
    if (!input.mediaCatalog) fail("POLICY_VIOLATION");
    // Catalog mutation serialization is page-first. The shared advisory fence
    // is intentionally acquired after that page row and before the consumer-
    // owned readiness read; Catalog never takes a public-media asset row lock.
    await acquirePublicMediaRetentionFences(tx, references.map((reference) => reference.assetId));
    const resolved = await input.mediaCatalog.resolveReadyAssets(tx, ownerUserId, references);
    exactReadyMap(references, resolved, ownerUserId);
  }

  async function workspace(database: PawketDatabase | PawketTransaction, userId: string, pageId: string, version?: number): Promise<CatalogWorkspace> {
    policy(validUuid(pageId));
    const seed = await requireCreator(database, userId, false);
    const [page] = await database.select().from(creatorPages).where(and(eq(creatorPages.id, pageId), eq(creatorPages.userId, userId))).limit(1);
    if (!page) fail("NOT_FOUND");
    const [draft] = await database.select().from(creatorPageDrafts).where(eq(creatorPageDrafts.pageId, page.id)).limit(1);
    if (!draft) fail("NOT_FOUND");
    const handles = await database.select().from(creatorHandleClaims).where(eq(creatorHandleClaims.pageId, page.id));
    const showcases = await database.select().from(creatorShowcaseDrafts).where(and(eq(creatorShowcaseDrafts.pageId, page.id), isNull(creatorShowcaseDrafts.removedAt))).orderBy(asc(creatorShowcaseDrafts.position));
    if (showcases.some((showcase) => showcase.contentLabel !== "general_audience")) throw new Error("Catalog workspace malformed");
    const showcaseRows = await Promise.all(showcases.map(async (showcase) => ({
      id: showcase.id, position: showcase.position, title: showcase.title, description: showcase.description, discipline: showcase.discipline,
      contentLabel: "general_audience" as const, externalUrl: showcase.externalUrl,
      media: (await database.select().from(creatorShowcaseDraftMedia).where(eq(creatorShowcaseDraftMedia.showcaseId, showcase.id)).orderBy(asc(creatorShowcaseDraftMedia.position))).map((media) => ({ assetId: media.assetId, alternativeText: media.alternativeText, position: media.position })),
    })));
    const canonical = handles.find((handle) => handle.kind === "canonical")?.normalizedHandle ?? null;
    let enforcement: CatalogWorkspace["enforcement"] = { pageHeld: false, heldShowcaseIds: [] };
    if (page.publishedRevisionId) {
      if (!input.visibility) throw new Error("Catalog visibility unavailable");
      const publishedShowcases = await database.select({ sourceShowcaseId: creatorPublicationShowcases.sourceShowcaseId })
        .from(creatorPublicationShowcases)
        .where(eq(creatorPublicationShowcases.revisionId, page.publishedRevisionId))
        .orderBy(asc(creatorPublicationShowcases.position));
      const showcaseIds = publishedShowcases.map((showcase) => showcase.sourceShowcaseId);
      const holds = exactHolds(await input.visibility.readHolds(database, page.id, page.publishedRevisionId, showcaseIds), showcaseIds);
      if (!holds) throw new Error("Catalog visibility malformed");
      enforcement = {
        pageHeld: holds.pageHeld,
        heldShowcaseIds: showcaseIds.filter((showcaseId) => holds.heldShowcaseIds.has(showcaseId)),
      };
    }
    return {
      pageId: page.id, draftVersion: version ?? page.draftVersion, publishedRevisionId: page.publishedRevisionId, canonicalHandle: canonical,
      aliases: handles.filter((handle) => handle.kind === "alias").map((handle) => handle.normalizedHandle), renameAvailableAt: page.renameAvailableAt,
      draft: { displayName: draft.displayName, introduction: draft.shortIntroduction, primaryDiscipline: draft.primaryDiscipline, secondaryDisciplines: draft.secondaryDisciplines, avatarAssetId: draft.avatarAssetId, coverAssetId: draft.coverAssetId }, showcases: showcaseRows,
      capabilityState: seed.capabilityState,
      enforcement,
    };
  }

  async function completeMutation(tx: PawketTransaction, started: { recordId: string }, pageId: string, nextVersion: number, at: Date, eventType: string, correlationId: string, actorUserId: string) {
    const completed = await completeIdempotentCommand(tx, { recordId: started.recordId, resultReference: replayReference(pageId, nextVersion), completedAt: at });
    if (!completed) fail("IDEMPOTENCY_CONFLICT");
    await insertOutboxEvent(tx, { eventType, eventVersion: 1, aggregateType: "creator_page", aggregateId: pageId, payload: { pageId, version: nextVersion, correlationId, actorUserId }, occurredAt: at });
  }

  async function mutate(
    scope: string,
    command: VersionedCatalogCommand,
    fingerprint: unknown,
    activeOnly: boolean,
    eventType: string,
    change: (tx: PawketTransaction, page: typeof creatorPages.$inferSelect, at: Date) => Promise<void>,
    beforeChange?: (at: Date) => void,
  ) {
    policy(validUuid(command.pageId) && validIdempotencyKey(command.idempotencyKey) && validRequestId(command.requestId) && Number.isInteger(command.expectedVersion));
    const at = now();
    return input.db.transaction(async (tx) => {
      const page = await lockOwnedPage(tx, command.actor.userId, command.pageId);
      const started = await beginIdempotentCommand(tx, {
        actorUserId: command.actor.userId, commandScope: scope,
        keyHash: createLookupHmac({ value: command.idempotencyKey, context: "catalog-command-key", key: input.commandFingerprintKey }),
        requestFingerprint: createLookupHmac({ value: JSON.stringify(fingerprint), context: "catalog-command", key: input.commandFingerprintKey }),
        expiresAt: new Date(at.getTime() + IDEMPOTENCY_LIFETIME_MS), now: at,
      });
      if (started.kind === "replay") {
        const replay = parseReplayReference(started.resultReference); if (!replay || replay.pageId !== page.id) fail("IDEMPOTENCY_CONFLICT");
        return { pageId: replay.pageId, draftVersion: replay.version };
      }
      if (started.kind !== "acquired") fail("IDEMPOTENCY_CONFLICT");
      if (input.publishingMode !== "general_audience") fail("PUBLISHING_DISABLED");
      await requireCreator(tx, command.actor.userId, activeOnly);
      beforeChange?.(at);
      if (page.draftVersion !== command.expectedVersion) fail("VERSION_CONFLICT");
      await change(tx, page, at);
      const nextVersion = page.draftVersion + 1;
      const [updated] = await tx.update(creatorPages).set({ draftVersion: nextVersion, updatedAt: at }).where(and(eq(creatorPages.id, page.id), eq(creatorPages.draftVersion, page.draftVersion))).returning({ id: creatorPages.id });
      if (!updated) fail("VERSION_CONFLICT");
      await completeMutation(tx, started, page.id, nextVersion, at, eventType, command.requestId, command.actor.userId);
      return { pageId: page.id, draftVersion: nextVersion };
    });
  }

  function assertRecentAuthentication(actor: CatalogActor, at: Date) {
    const age = at.getTime() - actor.primaryAuthenticatedAt.getTime();
    if (!actor.sessionId || Number.isNaN(age) || age < 0 || age > HANDLE_RECENT_AUTH_MS) fail("RECENT_AUTH_REQUIRED");
  }

  function assertPublicationCommand(command: VersionedCatalogCommand) {
    policy(
      validUuid(command.pageId) &&
      validIdempotencyKey(command.idempotencyKey) &&
      validRequestId(command.requestId) &&
      Number.isInteger(command.expectedVersion) &&
      command.expectedVersion > 0 &&
      Boolean(command.actor.sessionId),
    );
  }

  async function completePublicationCommand(tx: PawketTransaction, recordId: string, resultReference: string, completedAt: Date) {
    if (!await completeIdempotentCommand(tx, { recordId, resultReference, completedAt })) fail("IDEMPOTENCY_CONFLICT");
  }

  return {
    async initialize(command: { userId: string; requestId: string }) {
      policy(validRequestId(command.requestId));
      const at = now();
      return input.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`catalog-page:${command.userId}`}, 0))`);
        const existing = await tx.select({ id: creatorPages.id }).from(creatorPages).where(eq(creatorPages.userId, command.userId)).limit(1).for("update");
        if (existing[0]) return workspace(tx, command.userId, existing[0].id);
        const seed = await requireCreator(tx, command.userId, true);
        if (input.publishingMode !== "general_audience") fail("PUBLISHING_DISABLED");
        const pageId = id();
        const displayName = normalizeProfileText(seed.displayName, { minCodePoints: 1, maxCodePoints: 80 });
        const introduction = normalizeProfileText(seed.introduction, { minCodePoints: 1, maxCodePoints: 500 });
        await tx.insert(creatorPages).values({ id: pageId, userId: command.userId, draftVersion: 1, publishedRevisionId: null, renameAvailableAt: null, initializedFromRevisionId: seed.approvedRevisionId, createdAt: at, updatedAt: at });
        await tx.insert(creatorPageDrafts).values({ pageId, displayName, shortIntroduction: introduction, primaryDiscipline: "other", secondaryDisciplines: [], avatarAssetId: null, coverAssetId: null, createdAt: at, updatedAt: at });
        await insertOutboxEvent(tx, { eventType: "creator.page_initialized.v1", eventVersion: 1, aggregateType: "creator_page", aggregateId: pageId, payload: { pageId, version: 1, correlationId: command.requestId, actorUserId: command.userId }, occurredAt: at });
        return workspace(tx, command.userId, pageId);
      });
    },
    async getWorkspace(command: { actorUserId: string; pageId: string }) { return workspace(input.db, command.actorUserId, command.pageId); },
    async claimHandle(command: VersionedCatalogCommand & { handle: unknown }) {
      let handle: string; try { handle = normalizeHandle(command.handle); } catch { fail("POLICY_VIOLATION"); }
      try {
        return await mutate("catalog.handle.claim", command, { pageId: command.pageId, handle }, true, "creator.handle_claimed.v1", async (tx, page, occurredAt) => {
          const current = await tx.select({ id: creatorHandleClaims.id }).from(creatorHandleClaims).where(and(eq(creatorHandleClaims.pageId, page.id), eq(creatorHandleClaims.kind, "canonical"))).limit(1).for("update");
          if (current[0]) fail("HANDLE_UNAVAILABLE");
          await tx.insert(creatorHandleClaims).values({ id: id(), pageId: page.id, normalizedHandle: handle, kind: "canonical", claimedAt: occurredAt, replacedAt: null });
        }, (occurredAt) => assertRecentAuthentication(command.actor, occurredAt));
      } catch (error) { if (databaseConstraint(error, "creator_handle_claims_normalized_handle_uidx")) fail("HANDLE_UNAVAILABLE"); throw error; }
    },
    async renameHandle(command: VersionedCatalogCommand & { handle: unknown }) {
      let handle: string; try { handle = normalizeHandle(command.handle); } catch { fail("POLICY_VIOLATION"); }
      try {
        return await mutate("catalog.handle.rename", command, { pageId: command.pageId, handle }, true, "creator.handle_renamed.v1", async (tx, page, occurredAt) => {
          if (page.renameAvailableAt && page.renameAvailableAt > occurredAt) fail("RENAME_COOLDOWN");
          const [current] = await tx.select().from(creatorHandleClaims).where(and(eq(creatorHandleClaims.pageId, page.id), eq(creatorHandleClaims.kind, "canonical"))).limit(1).for("update");
          if (!current || current.normalizedHandle === handle) fail("HANDLE_UNAVAILABLE");
          await tx.update(creatorHandleClaims).set({ kind: "alias", replacedAt: occurredAt }).where(eq(creatorHandleClaims.id, current.id));
          await tx.insert(creatorHandleClaims).values({ id: id(), pageId: page.id, normalizedHandle: handle, kind: "canonical", claimedAt: occurredAt, replacedAt: null });
          await tx.update(creatorPages).set({ renameAvailableAt: new Date(occurredAt.getTime() + HANDLE_RENAME_COOLDOWN_MS) }).where(eq(creatorPages.id, page.id));
          await tx.update(creatorDiscoveryProjections).set({ canonicalHandle: handle }).where(eq(creatorDiscoveryProjections.pageId, page.id));
        }, (occurredAt) => assertRecentAuthentication(command.actor, occurredAt));
      } catch (error) { if (databaseConstraint(error, "creator_handle_claims_normalized_handle_uidx")) fail("HANDLE_UNAVAILABLE"); throw error; }
    },
    async saveDraft(command: VersionedCatalogCommand & { draft: DraftInput }) {
      const draft = normalizeDraft(command.draft);
      return mutate("catalog.page.save", command, { pageId: command.pageId, draft }, false, "creator.page_draft_saved.v1", async (tx, page, at) => {
        const [current] = await tx.select({ avatarAssetId: creatorPageDrafts.avatarAssetId, coverAssetId: creatorPageDrafts.coverAssetId })
          .from(creatorPageDrafts)
          .where(eq(creatorPageDrafts.pageId, page.id))
          .limit(1)
          .for("update");
        if (!current) fail("NOT_FOUND");
        const references: MediaReference[] = [];
        if (draft.avatarAssetId && draft.avatarAssetId !== current.avatarAssetId) references.push({ assetId: draft.avatarAssetId, purpose: "avatar", altText: null });
        if (draft.coverAssetId && draft.coverAssetId !== current.coverAssetId) references.push({ assetId: draft.coverAssetId, purpose: "cover", altText: null });
        await validateNewMediaReferences(tx, command.actor.userId, references);
        const updated = await tx.update(creatorPageDrafts).set({ displayName: draft.displayName, shortIntroduction: draft.introduction, primaryDiscipline: draft.primaryDiscipline, secondaryDisciplines: draft.secondaryDisciplines, avatarAssetId: draft.avatarAssetId, coverAssetId: draft.coverAssetId, updatedAt: at }).where(eq(creatorPageDrafts.pageId, page.id)).returning({ pageId: creatorPageDrafts.pageId });
        if (updated.length !== 1) fail("NOT_FOUND");
      });
    },
    async upsertShowcase(command: VersionedCatalogCommand & { showcase: ShowcaseInput }) {
      const showcase = normalizeShowcase(command.showcase);
      if (showcase.id !== undefined) policy(validUuid(showcase.id));
      return mutate("catalog.showcase.upsert", command, { pageId: command.pageId, showcase }, false, "creator.showcase_upserted.v1", async (tx, page, at) => {
        const [occupied] = await tx.select({ id: creatorShowcaseDrafts.id }).from(creatorShowcaseDrafts).where(and(eq(creatorShowcaseDrafts.pageId, page.id), eq(creatorShowcaseDrafts.position, showcase.position), isNull(creatorShowcaseDrafts.removedAt))).limit(1).for("update");
        if (occupied && occupied.id !== showcase.id) fail("POLICY_VIOLATION");
        const showcaseId = showcase.id ?? id();
        if (showcase.id) {
          const [existing] = await tx.select({ id: creatorShowcaseDrafts.id }).from(creatorShowcaseDrafts).where(and(eq(creatorShowcaseDrafts.id, showcase.id), eq(creatorShowcaseDrafts.pageId, page.id), isNull(creatorShowcaseDrafts.removedAt))).limit(1).for("update");
          if (!existing) fail("NOT_FOUND");
          const existingMedia = await tx.select({ assetId: creatorShowcaseDraftMedia.assetId })
            .from(creatorShowcaseDraftMedia)
            .where(eq(creatorShowcaseDraftMedia.showcaseId, showcaseId))
            .for("update");
          const existingAssetIds = new Set(existingMedia.map((media) => media.assetId));
          const references = showcase.media
            .filter((media) => !existingAssetIds.has(media.assetId as string))
            .map((media) => ({ assetId: media.assetId as string, purpose: "showcase" as const, altText: media.alternativeText }));
          await validateNewMediaReferences(tx, command.actor.userId, references);
          await tx.update(creatorShowcaseDrafts).set({ position: showcase.position, title: showcase.title, description: showcase.description, discipline: showcase.discipline, contentLabel: showcase.contentLabel, externalUrl: showcase.externalUrl, updatedAt: at }).where(eq(creatorShowcaseDrafts.id, showcaseId));
          await tx.delete(creatorShowcaseDraftMedia).where(eq(creatorShowcaseDraftMedia.showcaseId, showcaseId));
        } else {
          await validateNewMediaReferences(tx, command.actor.userId, showcase.media.map((media) => ({ assetId: media.assetId as string, purpose: "showcase", altText: media.alternativeText })));
          await tx.insert(creatorShowcaseDrafts).values({ id: showcaseId, pageId: page.id, position: showcase.position, title: showcase.title, description: showcase.description, discipline: showcase.discipline, contentLabel: showcase.contentLabel, externalUrl: showcase.externalUrl, removedAt: null, createdAt: at, updatedAt: at });
        }
        if (showcase.media.length) await tx.insert(creatorShowcaseDraftMedia).values(showcase.media.map((media, position) => ({ id: id(), showcaseId, assetId: media.assetId as string, position, alternativeText: media.alternativeText, createdAt: at, updatedAt: at })));
      });
    },
    async removeShowcase(command: VersionedCatalogCommand & { showcaseId: string }) {
      policy(validUuid(command.showcaseId));
      return mutate("catalog.showcase.remove", command, { pageId: command.pageId, showcaseId: command.showcaseId }, false, "creator.showcase_removed.v1", async (tx, page, at) => {
        const [removed] = await tx.update(creatorShowcaseDrafts).set({ removedAt: at, updatedAt: at }).where(and(eq(creatorShowcaseDrafts.id, command.showcaseId), eq(creatorShowcaseDrafts.pageId, page.id), isNull(creatorShowcaseDrafts.removedAt))).returning({ id: creatorShowcaseDrafts.id });
        if (!removed) fail("NOT_FOUND");
      });
    },
    async reorderShowcases(command: VersionedCatalogCommand & { showcaseIds: readonly string[] }) {
      policy(command.showcaseIds.length <= 12 && new Set(command.showcaseIds).size === command.showcaseIds.length && command.showcaseIds.every(validUuid));
      return mutate("catalog.showcase.reorder", command, { pageId: command.pageId, showcaseIds: command.showcaseIds }, false, "creator.showcase_reordered.v1", async (tx, page, at) => {
        const active = await tx.select({ id: creatorShowcaseDrafts.id }).from(creatorShowcaseDrafts).where(and(eq(creatorShowcaseDrafts.pageId, page.id), isNull(creatorShowcaseDrafts.removedAt))).orderBy(asc(creatorShowcaseDrafts.position)).for("update");
        if (active.length !== command.showcaseIds.length || !active.every((row) => command.showcaseIds.includes(row.id))) fail("POLICY_VIOLATION");
        if (active.length === 0) return;
        const activeIds = active.map((row) => row.id);
        const deactivated = await tx.update(creatorShowcaseDrafts).set({ removedAt: at, updatedAt: at }).where(and(eq(creatorShowcaseDrafts.pageId, page.id), inArray(creatorShowcaseDrafts.id, activeIds), isNull(creatorShowcaseDrafts.removedAt))).returning({ id: creatorShowcaseDrafts.id });
        if (deactivated.length !== active.length) fail("VERSION_CONFLICT");
        for (const [position, showcaseId] of command.showcaseIds.entries()) {
          const updated = await tx.update(creatorShowcaseDrafts).set({ position, updatedAt: at }).where(and(eq(creatorShowcaseDrafts.id, showcaseId), eq(creatorShowcaseDrafts.pageId, page.id), eq(creatorShowcaseDrafts.removedAt, at))).returning({ id: creatorShowcaseDrafts.id });
          if (updated.length !== 1) fail("VERSION_CONFLICT");
        }
        const reactivated = await tx.update(creatorShowcaseDrafts).set({ removedAt: null, updatedAt: at }).where(and(eq(creatorShowcaseDrafts.pageId, page.id), inArray(creatorShowcaseDrafts.id, activeIds), eq(creatorShowcaseDrafts.removedAt, at))).returning({ id: creatorShowcaseDrafts.id });
        if (reactivated.length !== active.length) fail("VERSION_CONFLICT");
      });
    },
    async publish(command: VersionedCatalogCommand): Promise<PublishResult> {
      assertPublicationCommand(command);
      const occurredAt = now();
      return input.db.transaction(async (tx) => {
        const page = await lockOwnedPage(tx, command.actor.userId, command.pageId);
        const started = await beginIdempotentCommand(tx, {
          actorUserId: command.actor.userId,
          commandScope: "catalog.page.publish",
          keyHash: createLookupHmac({ value: command.idempotencyKey, context: "catalog-command-key", key: input.commandFingerprintKey }),
          requestFingerprint: createLookupHmac({ value: JSON.stringify({ pageId: command.pageId, expectedVersion: command.expectedVersion }), context: "catalog-command", key: input.commandFingerprintKey }),
          expiresAt: new Date(occurredAt.getTime() + IDEMPOTENCY_LIFETIME_MS),
          now: occurredAt,
        });
        if (started.kind === "replay") {
          const replay = parsePublicationReplayReference(started.resultReference);
          if (!replay || replay.pageId !== page.id) fail("IDEMPOTENCY_CONFLICT");
          return replay;
        }
        if (started.kind !== "acquired") fail("IDEMPOTENCY_CONFLICT");
        if (input.publishingMode !== "general_audience") fail("PUBLISHING_DISABLED");
        await requireCreator(tx, command.actor.userId, true);
        if (!input.mediaCatalog || !input.visibility) fail("POLICY_VIOLATION");
        if (page.draftVersion !== command.expectedVersion) fail("VERSION_CONFLICT");

        const [draft] = await tx.select().from(creatorPageDrafts).where(eq(creatorPageDrafts.pageId, page.id)).limit(1).for("update");
        const [canonical] = await tx.select().from(creatorHandleClaims).where(and(eq(creatorHandleClaims.pageId, page.id), eq(creatorHandleClaims.kind, "canonical"))).limit(1).for("update");
        if (!draft || !canonical) fail("POLICY_VIOLATION");
        let canonicalHandle: string;
        try { canonicalHandle = normalizeHandle(canonical.normalizedHandle); } catch { fail("POLICY_VIOLATION"); }
        const normalizedDraft = normalizeDraft({
          displayName: draft.displayName,
          introduction: draft.shortIntroduction,
          primaryDiscipline: draft.primaryDiscipline,
          secondaryDisciplines: draft.secondaryDisciplines,
          avatarAssetId: draft.avatarAssetId,
          coverAssetId: draft.coverAssetId,
        });
        const showcases = await tx.select().from(creatorShowcaseDrafts).where(and(eq(creatorShowcaseDrafts.pageId, page.id), isNull(creatorShowcaseDrafts.removedAt))).orderBy(asc(creatorShowcaseDrafts.position)).for("update");
        const showcaseIds = showcases.map((showcase) => showcase.id);
        const mediaRows = showcaseIds.length === 0
          ? []
          : await tx.select().from(creatorShowcaseDraftMedia).where(inArray(creatorShowcaseDraftMedia.showcaseId, showcaseIds)).orderBy(asc(creatorShowcaseDraftMedia.position)).for("update");
        const normalizedShowcases = showcases.map((showcase) => normalizeShowcase({
          id: showcase.id,
          position: showcase.position,
          title: showcase.title,
          description: showcase.description,
          discipline: showcase.discipline,
          contentLabel: showcase.contentLabel,
          externalUrl: showcase.externalUrl,
          media: mediaRows.filter((item) => item.showcaseId === showcase.id).map((item) => ({ assetId: item.assetId, alternativeText: item.alternativeText })),
        }));
        const revisionId = id();
        const holds = exactHolds(await input.visibility.readHolds(tx, page.id, revisionId, showcaseIds), showcaseIds);
        if (!holds) fail("POLICY_VIOLATION");
        if (holds.pageHeld || showcases.some((showcase) => holds.heldShowcaseIds.has(showcase.id))) fail("POLICY_VIOLATION");

        const references: MediaReference[] = [];
        if (normalizedDraft.avatarAssetId) references.push({ assetId: normalizedDraft.avatarAssetId, purpose: "avatar", altText: null });
        if (normalizedDraft.coverAssetId) references.push({ assetId: normalizedDraft.coverAssetId, purpose: "cover", altText: null });
        for (const showcase of normalizedShowcases) for (const item of showcase.media) references.push({ assetId: item.assetId, purpose: "showcase", altText: item.alternativeText });
        const resolved = await input.mediaCatalog.resolveReadyAssets(tx, command.actor.userId, references);
        const resolvedByReference = exactReadyMap(references, resolved, command.actor.userId);
        const avatar = normalizedDraft.avatarAssetId ? resolvedByReference.get(normalizedDraft.avatarAssetId) : undefined;
        const cover = normalizedDraft.coverAssetId ? resolvedByReference.get(normalizedDraft.coverAssetId) : undefined;
        const maximumRevision = (await tx.select({ maximumRevision: max(creatorPublicationRevisions.revisionNumber) }).from(creatorPublicationRevisions).where(eq(creatorPublicationRevisions.pageId, page.id)))[0]?.maximumRevision;
        const revisionNumber = (maximumRevision ?? 0) + 1;
        await tx.insert(creatorPublicationRevisions).values({
          id: revisionId,
          pageId: page.id,
          revisionNumber,
          canonicalHandle,
          displayName: normalizedDraft.displayName,
          shortIntroduction: normalizedDraft.introduction,
          primaryDiscipline: normalizedDraft.primaryDiscipline,
          secondaryDisciplines: normalizedDraft.secondaryDisciplines,
          avatarAssetId: avatar?.assetId ?? null,
          avatarThumbDerivativeId: avatar?.derivatives.thumb.derivativeId ?? null,
          avatarDisplayDerivativeId: avatar?.derivatives.display.derivativeId ?? null,
          coverAssetId: cover?.assetId ?? null,
          coverDisplayDerivativeId: cover?.derivatives.display.derivativeId ?? null,
          taxonomyVersion: TAXONOMY_VERSION,
          policyVersion: CONTENT_POLICY_VERSION,
          actorUserId: command.actor.userId,
          actorSessionId: command.actor.sessionId,
          expectedDraftVersion: command.expectedVersion,
          requestId: command.requestId,
          publishedAt: occurredAt,
        });
        for (const showcase of normalizedShowcases) {
          const publicationShowcaseId = id();
          await tx.insert(creatorPublicationShowcases).values({
            id: publicationShowcaseId,
            revisionId,
            sourceShowcaseId: showcase.id!,
            position: showcase.position,
            title: showcase.title,
            description: showcase.description,
            discipline: showcase.discipline,
            contentLabel: showcase.contentLabel,
            externalUrl: showcase.externalUrl,
          });
          if (showcase.media.length > 0) {
            await tx.insert(creatorPublicationMedia).values(showcase.media.map((item, position) => {
              const itemMedia = resolvedByReference.get(item.assetId);
              if (!itemMedia) fail("POLICY_VIOLATION");
              return {
                id: id(), publicationShowcaseId, assetId: item.assetId, position,
                alternativeText: item.alternativeText,
                thumbDerivativeId: itemMedia.derivatives.thumb.derivativeId,
                displayDerivativeId: itemMedia.derivatives.display.derivativeId,
                largeDerivativeId: itemMedia.derivatives.large.derivativeId,
              };
            }));
          }
        }
        const [head] = await tx.update(creatorPages).set({ publishedRevisionId: revisionId, updatedAt: occurredAt }).where(and(eq(creatorPages.id, page.id), eq(creatorPages.draftVersion, command.expectedVersion))).returning({ id: creatorPages.id });
        if (!head) fail("VERSION_CONFLICT");
        await tx.insert(creatorDiscoveryProjections).values({
          pageId: page.id,
          revisionId,
          canonicalHandle,
          displayName: normalizedDraft.displayName,
          shortIntroduction: normalizedDraft.introduction,
          disciplines: [normalizedDraft.primaryDiscipline, ...normalizedDraft.secondaryDisciplines],
          avatarThumbDerivativeId: avatar?.derivatives.thumb.derivativeId ?? null,
          revisionAt: occurredAt,
          enabled: true,
        }).onConflictDoUpdate({ target: creatorDiscoveryProjections.pageId, set: {
          revisionId,
          canonicalHandle,
          displayName: normalizedDraft.displayName,
          shortIntroduction: normalizedDraft.introduction,
          disciplines: [normalizedDraft.primaryDiscipline, ...normalizedDraft.secondaryDisciplines],
          avatarThumbDerivativeId: avatar?.derivatives.thumb.derivativeId ?? null,
          revisionAt: occurredAt,
          enabled: true,
        } });
        await tx.insert(creatorPublicationEvents).values({ id: id(), pageId: page.id, revisionId, type: "published", actorUserId: command.actor.userId, actorSessionId: command.actor.sessionId, expectedDraftVersion: command.expectedVersion, requestId: command.requestId, occurredAt });
        const result: PublishResult = { pageId: page.id, revisionId, revisionNumber, canonicalHandle, draftVersion: command.expectedVersion, publishedAt: occurredAt };
        await completePublicationCommand(tx, started.recordId, publicationReplayReference(result), occurredAt);
        await insertOutboxEvent(tx, { eventType: "creator.page_published.v1", eventVersion: 1, aggregateType: "creator_page", aggregateId: page.id, payload: { pageId: page.id, revisionId, revisionNumber, draftVersion: command.expectedVersion, correlationId: command.requestId, actorUserId: command.actor.userId }, occurredAt });
        return result;
      });
    },
    async unpublish(command: VersionedCatalogCommand): Promise<UnpublishResult> {
      assertPublicationCommand(command);
      const occurredAt = now();
      return input.db.transaction(async (tx) => {
        const page = await lockOwnedPage(tx, command.actor.userId, command.pageId);
        const started = await beginIdempotentCommand(tx, {
          actorUserId: command.actor.userId,
          commandScope: "catalog.page.unpublish",
          keyHash: createLookupHmac({ value: command.idempotencyKey, context: "catalog-command-key", key: input.commandFingerprintKey }),
          requestFingerprint: createLookupHmac({ value: JSON.stringify({ pageId: command.pageId, expectedVersion: command.expectedVersion }), context: "catalog-command", key: input.commandFingerprintKey }),
          expiresAt: new Date(occurredAt.getTime() + IDEMPOTENCY_LIFETIME_MS),
          now: occurredAt,
        });
        if (started.kind === "replay") {
          const replay = parseUnpublicationReplayReference(started.resultReference);
          if (!replay || replay.pageId !== page.id) fail("IDEMPOTENCY_CONFLICT");
          return replay;
        }
        if (started.kind !== "acquired") fail("IDEMPOTENCY_CONFLICT");
        if (input.publishingMode !== "general_audience") fail("PUBLISHING_DISABLED");
        await requireCreator(tx, command.actor.userId, true);
        if (page.draftVersion !== command.expectedVersion) fail("VERSION_CONFLICT");
        if (!page.publishedRevisionId) fail("POLICY_VIOLATION");
        const previousPublishedRevisionId = page.publishedRevisionId;
        await tx.update(creatorPages).set({ publishedRevisionId: null, updatedAt: occurredAt }).where(eq(creatorPages.id, page.id));
        const projection = await tx.update(creatorDiscoveryProjections).set({ enabled: false }).where(and(eq(creatorDiscoveryProjections.pageId, page.id), eq(creatorDiscoveryProjections.revisionId, previousPublishedRevisionId))).returning({ pageId: creatorDiscoveryProjections.pageId });
        if (projection.length !== 1) fail("POLICY_VIOLATION");
        await tx.insert(creatorPublicationEvents).values({ id: id(), pageId: page.id, revisionId: previousPublishedRevisionId, type: "unpublished", actorUserId: command.actor.userId, actorSessionId: command.actor.sessionId, expectedDraftVersion: command.expectedVersion, requestId: command.requestId, occurredAt });
        const result: UnpublishResult = { pageId: page.id, previousPublishedRevisionId, draftVersion: command.expectedVersion, unpublishedAt: occurredAt };
        await completePublicationCommand(tx, started.recordId, unpublicationReplayReference(result), occurredAt);
        await insertOutboxEvent(tx, { eventType: "creator.page_unpublished.v1", eventVersion: 1, aggregateType: "creator_page", aggregateId: page.id, payload: { pageId: page.id, revisionId: previousPublishedRevisionId, draftVersion: command.expectedVersion, correlationId: command.requestId, actorUserId: command.actor.userId }, occurredAt });
        return result;
      });
    },
    async clearPublishedHeadForSuspension(tx: PawketTransaction, transition: SuspensionPublicationClear) {
      policy(validRequestId(transition.requestId) && validRequestId(transition.reasonCode) && Boolean(transition.actorSessionId));
      const [page] = await tx.select().from(creatorPages).where(eq(creatorPages.userId, transition.creatorUserId)).limit(1).for("update");
      if (!page) return { pageId: null, previousPublishedRevisionId: null };
      if (!page.publishedRevisionId) {
        await tx.update(creatorDiscoveryProjections).set({ enabled: false }).where(eq(creatorDiscoveryProjections.pageId, page.id));
        return { pageId: page.id, previousPublishedRevisionId: null };
      }
      const previousPublishedRevisionId = page.publishedRevisionId;
      await tx.update(creatorPages).set({ publishedRevisionId: null, updatedAt: transition.occurredAt }).where(eq(creatorPages.id, page.id));
      const projection = await tx.update(creatorDiscoveryProjections).set({ enabled: false }).where(and(eq(creatorDiscoveryProjections.pageId, page.id), eq(creatorDiscoveryProjections.revisionId, previousPublishedRevisionId))).returning({ pageId: creatorDiscoveryProjections.pageId });
      if (projection.length !== 1) fail("POLICY_VIOLATION");
      await tx.insert(creatorPublicationEvents).values({ id: id(), pageId: page.id, revisionId: previousPublishedRevisionId, type: "suspension_unpublish", actorUserId: transition.actorUserId, actorSessionId: transition.actorSessionId, expectedDraftVersion: page.draftVersion, requestId: transition.requestId, occurredAt: transition.occurredAt });
      await insertOutboxEvent(tx, { eventType: "creator.page_unpublished.v1", eventVersion: 1, aggregateType: "creator_page", aggregateId: page.id, payload: { pageId: page.id, revisionId: previousPublishedRevisionId, draftVersion: page.draftVersion, correlationId: transition.requestId, actorUserId: transition.actorUserId, reasonCode: transition.reasonCode }, occurredAt: transition.occurredAt });
      return { pageId: page.id, previousPublishedRevisionId };
    },
  };
}
