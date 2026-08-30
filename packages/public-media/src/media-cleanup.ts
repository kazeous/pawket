import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  acquirePublicMediaRetentionFences,
  publicMediaAssets,
  publicMediaDerivatives,
  type PawketDatabase,
  type PawketTransaction,
} from "@pawket/database";
import { and, eq, sql } from "drizzle-orm";

import { isOpaqueVersionId, isRawStorageEtag } from "./media-policy.js";
import type {
  PublicMediaRetentionAcceptancePort,
  PublicMediaRetentionHoldPort,
} from "./media-ports.js";
import type { HeadObjectResult, ObjectStoragePort } from "./object-storage-port.js";
import { readExactNativeArray, readExactOwnRecord } from "./runtime-boundary.js";

export type PublicMediaCleanupRule =
  | "processed_source"
  | "failed_quarantine"
  | "ready_unreferenced"
  | "superseded_derivative";

export type PublicMediaCleanupDisposition = "candidate" | "protected" | "processed" | "failed";

export type PublicMediaCleanupResult = Readonly<{
  results: readonly Readonly<{
    assetId: string;
    rule: PublicMediaCleanupRule;
    eligibleAt: Date;
    objectKeyHash: string;
    disposition: PublicMediaCleanupDisposition;
    bytesDeleted: number;
  }>[];
  counts: Readonly<Record<PublicMediaCleanupRule, Readonly<Record<PublicMediaCleanupDisposition, number>>>>;
  candidateCount: number;
  protectedCount: number;
  processedCount: number;
  failedCount: number;
  oldestEligibleAt: Date | null;
}>;

type Input = Readonly<{
  db: PawketDatabase;
  storage?: Pick<ObjectStoragePort, "headObject" | "listObjectVersions" | "deleteObject">;
  holds?: PublicMediaRetentionHoldPort;
  now: Date;
  batchSize: number;
  mode: "report_only" | "enforce";
  retentionMode: "report_only" | "enforce";
  globalPause: boolean;
  acceptanceReference?: string;
  acceptance?: PublicMediaRetentionAcceptancePort;
}>;

type Candidate = Readonly<{
  assetId: string;
  rule: PublicMediaCleanupRule;
  eligibleAt: Date;
  targetKey: string;
  objectKeyHash: string;
  actualSourceBytes: number | null;
  sourceAllocationBytes: number;
}>;

type SafeDerivative = Readonly<{
  objectKey: string;
  objectVersionId: string;
  byteSize: number;
  contentHash: string;
}>;

const RULES: readonly PublicMediaCleanupRule[] = [
  "processed_source",
  "failed_quarantine",
  "ready_unreferenced",
  "superseded_derivative",
];
const DISPOSITIONS: readonly PublicMediaCleanupDisposition[] = ["candidate", "protected", "processed", "failed"];
const ACCEPTANCE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{7,199}$/u;
const CONTENT_HASH = /^sha256:v1:[A-Za-z0-9_-]{43}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class PublicMediaCleanupConfigurationError extends Error {
  constructor() {
    super("PUBLIC_MEDIA_CLEANUP_CONFIGURATION_INVALID");
    this.name = "PublicMediaCleanupConfigurationError";
  }
}

function configurationError(): never {
  throw new PublicMediaCleanupConfigurationError();
}

function snapshotInput(value: unknown): Input {
  const input = readExactOwnRecord(
    value,
    ["db", "now", "batchSize", "mode", "retentionMode", "globalPause"],
    ["storage", "holds", "acceptanceReference", "acceptance"],
  );
  if (
    !input ||
    !input.db || typeof input.db !== "object" ||
    !(input.now instanceof Date) || !Number.isFinite(input.now.getTime()) ||
    !Number.isInteger(input.batchSize) || (input.batchSize as number) < 1 || (input.batchSize as number) > 500 ||
    (input.mode !== "report_only" && input.mode !== "enforce") ||
    (input.retentionMode !== "report_only" && input.retentionMode !== "enforce") ||
    typeof input.globalPause !== "boolean"
  ) configurationError();
  if (
    input.mode === "enforce" &&
    (
      input.retentionMode !== "enforce" ||
      typeof input.acceptanceReference !== "string" ||
      !ACCEPTANCE_REFERENCE.test(input.acceptanceReference) ||
      !input.acceptance || typeof input.acceptance !== "object" || nodeTypes.isProxy(input.acceptance) ||
      !input.holds || typeof input.holds !== "object" || nodeTypes.isProxy(input.holds) ||
      !input.storage || typeof input.storage !== "object" || nodeTypes.isProxy(input.storage)
    )
  ) configurationError();
  if (input.storage !== undefined && (!input.storage || typeof input.storage !== "object" || nodeTypes.isProxy(input.storage))) configurationError();
  if (input.holds !== undefined && (!input.holds || typeof input.holds !== "object" || nodeTypes.isProxy(input.holds))) configurationError();
  const storage = input.storage as Partial<NonNullable<Input["storage"]>> | undefined;
  const holdsRecord = input.holds === undefined ? undefined : readExactOwnRecord(input.holds, ["protectedAssetIds"]);
  const acceptanceRecord = input.acceptance === undefined
    ? undefined
    : readExactOwnRecord(input.acceptance, ["lockCurrentAcceptedRevision"]);
  if (storage !== undefined && (typeof storage.headObject !== "function" || typeof storage.listObjectVersions !== "function" || typeof storage.deleteObject !== "function")) configurationError();
  if (holdsRecord !== undefined && (!holdsRecord || typeof holdsRecord.protectedAssetIds !== "function")) configurationError();
  if (acceptanceRecord !== undefined && (!acceptanceRecord || typeof acceptanceRecord.lockCurrentAcceptedRevision !== "function")) configurationError();
  const holds = holdsRecord === undefined
    ? undefined
    : { protectedAssetIds: holdsRecord.protectedAssetIds as PublicMediaRetentionHoldPort["protectedAssetIds"] };
  const acceptance = acceptanceRecord === undefined
    ? undefined
    : { lockCurrentAcceptedRevision: acceptanceRecord.lockCurrentAcceptedRevision as PublicMediaRetentionAcceptancePort["lockCurrentAcceptedRevision"] };
  return {
    db: input.db as PawketDatabase,
    now: new Date(input.now.getTime()),
    batchSize: input.batchSize as number,
    mode: input.mode,
    retentionMode: input.retentionMode,
    globalPause: input.globalPause,
    ...(storage === undefined ? {} : { storage: storage as NonNullable<Input["storage"]> }),
    ...(holds === undefined ? {} : { holds }),
    ...(input.acceptanceReference === undefined ? {} : { acceptanceReference: input.acceptanceReference as string }),
    ...(acceptance === undefined ? {} : { acceptance: acceptance as PublicMediaRetentionAcceptancePort }),
  };
}

async function authorizeEnforcement(input: Input, tx: PawketTransaction): Promise<void> {
  if (input.mode !== "enforce") return;
  let value: unknown;
  try {
    value = await input.acceptance!.lockCurrentAcceptedRevision(tx);
  } catch {
    configurationError();
  }
  const grant = readExactOwnRecord(value, ["acceptedRevision"]);
  if (
    !grant ||
    typeof grant.acceptedRevision !== "string" ||
    !ACCEPTANCE_REFERENCE.test(grant.acceptedRevision) ||
    grant.acceptedRevision !== input.acceptanceReference
  ) configurationError();
}

function emptyCounts(): Record<PublicMediaCleanupRule, Record<PublicMediaCleanupDisposition, number>> {
  return Object.fromEntries(RULES.map((rule) => [rule, Object.fromEntries(DISPOSITIONS.map((disposition) => [disposition, 0]))])) as Record<PublicMediaCleanupRule, Record<PublicMediaCleanupDisposition, number>>;
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function exactCandidate(value: unknown): Candidate | null {
  const row = readExactOwnRecord(value, ["asset_id", "rule", "eligible_at_ms", "target_key", "object_key_hash", "actual_source_bytes", "source_allocation_bytes"]);
  const eligibleAtMs = Number(row?.eligible_at_ms);
  if (!row || !UUID.test(row.asset_id as string) || !RULES.includes(row.rule as PublicMediaCleanupRule) || !Number.isFinite(eligibleAtMs) || typeof row.target_key !== "string" || row.target_key.length < 1 || row.target_key.length > 1024 || typeof row.object_key_hash !== "string" || row.object_key_hash !== hashKey(row.target_key)) return null;
  const actualSourceBytes = row.actual_source_bytes === null ? null : Number(row.actual_source_bytes);
  const sourceAllocationBytes = Number(row.source_allocation_bytes);
  if ((actualSourceBytes !== null && (!Number.isSafeInteger(actualSourceBytes) || actualSourceBytes < 1)) || !Number.isSafeInteger(sourceAllocationBytes) || sourceAllocationBytes < 0) return null;
  return {
    assetId: row.asset_id as string,
    rule: row.rule as PublicMediaCleanupRule,
    eligibleAt: new Date(eligibleAtMs),
    targetKey: row.target_key,
    objectKeyHash: row.object_key_hash,
    actualSourceBytes,
    sourceAllocationBytes,
  };
}

async function claimCandidates(tx: PawketTransaction, now: Date, batchSize: number): Promise<Candidate[]> {
  const result = await tx.execute(sql`
    with draft_refs(asset_id) as (
      select avatar_asset_id from creator_page_drafts where avatar_asset_id is not null
      union select cover_asset_id from creator_page_drafts where cover_asset_id is not null
      union
        select media.asset_id
        from creator_showcase_draft_media media
        join creator_showcase_drafts showcase on showcase.id = media.showcase_id
        where showcase.removed_at is null
    ),
    revision_refs(asset_id, page_id, published_at) as (
      select avatar_asset_id, page_id, published_at from creator_publication_revisions where avatar_asset_id is not null
      union all select cover_asset_id, page_id, published_at from creator_publication_revisions where cover_asset_id is not null
      union all
        select m.asset_id, r.page_id, r.published_at
        from creator_publication_media m
        join creator_publication_showcases s on s.id = m.publication_showcase_id
        join creator_publication_revisions r on r.id = s.revision_id
    ),
    live_refs(asset_id) as (
      select r.avatar_asset_id
      from creator_pages p join creator_publication_revisions r on r.id = p.published_revision_id
      where r.avatar_asset_id is not null
      union select r.cover_asset_id
      from creator_pages p join creator_publication_revisions r on r.id = p.published_revision_id
      where r.cover_asset_id is not null
      union
        select m.asset_id
        from creator_pages p
        join creator_publication_showcases s on s.revision_id = p.published_revision_id
        join creator_publication_media m on m.publication_showcase_id = s.id
    ),
    last_revision_ref as (
      select asset_id, page_id, max(published_at) as last_published_at
      from revision_refs group by asset_id, page_id
    ),
    left_live as (
      select refs.asset_id, min(events.occurred_at) as left_live_at
      from last_revision_ref refs
      join creator_publication_events events
        on events.page_id = refs.page_id and events.occurred_at > refs.last_published_at
      group by refs.asset_id
    ),
    derivative_key as (
      select asset_id, min(object_key) as object_key from public_media_derivatives group by asset_id
    ),
    unreferenced_clock as (
      select a.id as asset_id,
        case
          when page.id is null then a.ready_at
          when draft.page_id is null then null
          else greatest(
            a.ready_at,
            page.updated_at,
            draft.updated_at,
            coalesce(showcases.last_changed_at, a.ready_at)
          )
        end as unreferenced_at
      from public_media_assets a
      left join creator_pages page on page.user_id = a.owner_user_id
      left join creator_page_drafts draft on draft.page_id = page.id
      left join lateral (
        select max(greatest(showcase.updated_at, coalesce(showcase.removed_at, showcase.updated_at))) as last_changed_at
        from creator_showcase_drafts showcase
        where showcase.page_id = page.id
      ) showcases on true
    ),
    candidate_rules as (
      select a.id as asset_id, 'processed_source'::text as rule,
        a.ready_at + interval '24 hours' as eligible_at, a.source_object_key as target_key
      from public_media_assets a
      where a.state = 'ready' and a.source_deleted_at is null and a.ready_at is not null
      union all
      select a.id, 'failed_quarantine'::text,
        a.updated_at + interval '7 days', a.source_object_key
      from public_media_assets a
      where a.state = 'failed' and a.source_deleted_at is null
      union all
      select a.id, 'ready_unreferenced'::text,
        clocks.unreferenced_at + interval '30 days', keys.object_key
      from public_media_assets a
      join derivative_key keys on keys.asset_id = a.id
      join unreferenced_clock clocks on clocks.asset_id = a.id
      where a.state = 'ready' and a.ready_at is not null
        and clocks.unreferenced_at is not null
        and not exists (select 1 from draft_refs refs where refs.asset_id = a.id)
        and not exists (select 1 from revision_refs refs where refs.asset_id = a.id)
      union all
      select a.id, 'superseded_derivative'::text,
        left_live.left_live_at + interval '180 days', keys.object_key
      from public_media_assets a
      join derivative_key keys on keys.asset_id = a.id
      join left_live on left_live.asset_id = a.id
      where a.state = 'ready'
        and not exists (select 1 from draft_refs refs where refs.asset_id = a.id)
        and not exists (select 1 from live_refs refs where refs.asset_id = a.id)
        and exists (select 1 from revision_refs refs where refs.asset_id = a.id)
    )
    select a.id as asset_id, candidates.rule,
      extract(epoch from candidates.eligible_at) * 1000 as eligible_at_ms,
      candidates.target_key,
      encode(sha256(convert_to(candidates.target_key, 'UTF8')), 'hex') as object_key_hash,
      a.actual_source_bytes, a.source_allocation_bytes
    from candidate_rules candidates
    join public_media_assets a on a.id = candidates.asset_id
    where candidates.eligible_at <= ${now.toISOString()}::timestamptz
    order by candidates.eligible_at, candidates.asset_id,
      encode(sha256(convert_to(candidates.target_key, 'UTF8')), 'hex')
    limit ${batchSize}
    for update of a skip locked
  `);
  if (!Array.isArray(result) || nodeTypes.isProxy(result)) throw new Error("PUBLIC_MEDIA_CLEANUP_QUERY_INVALID");
  let values: readonly unknown[];
  try { values = Array.prototype.slice.call(result) as readonly unknown[]; }
  catch { throw new Error("PUBLIC_MEDIA_CLEANUP_QUERY_INVALID"); }
  const candidates: Candidate[] = [];
  for (const value of values) {
    const candidate = exactCandidate(value);
    if (!candidate) throw new Error("PUBLIC_MEDIA_CLEANUP_QUERY_INVALID");
    candidates.push(candidate);
  }
  return candidates;
}

function exactProtectedIds(value: unknown, expectedIds: ReadonlySet<string>): ReadonlySet<string> | null {
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value)) return null;
  try {
    if (Object.getPrototypeOf(value) !== Set.prototype || Reflect.ownKeys(value).length !== 0) return null;
    const output = new Set<string>();
    const iterator = Set.prototype.values.call(value) as SetIterator<unknown>;
    for (const entry of iterator) {
      if (typeof entry !== "string" || !expectedIds.has(entry)) return null;
      output.add(entry);
    }
    return output;
  } catch {
    return null;
  }
}

function exactVersions(value: unknown): readonly Readonly<{ versionId: string; isDeleteMarker: boolean }>[] | null {
  const versions = readExactNativeArray(value);
  if (!versions) return null;
  const seen = new Set<string>();
  const result: Array<{ versionId: string; isDeleteMarker: boolean }> = [];
  for (const candidate of versions) {
    const row = readExactOwnRecord(candidate, ["versionId", "isDeleteMarker"]);
    if (!row || !isOpaqueVersionId(row.versionId) || typeof row.isDeleteMarker !== "boolean" || seen.has(row.versionId)) return null;
    seen.add(row.versionId);
    result.push({ versionId: row.versionId, isDeleteMarker: row.isDeleteMarker });
  }
  return result;
}

function exactDerivative(value: unknown): SafeDerivative | null {
  const row = readExactOwnRecord(value, ["objectKey", "objectVersionId", "byteSize", "contentHash"]);
  if (!row || typeof row.objectKey !== "string" || !isOpaqueVersionId(row.objectVersionId) || !Number.isSafeInteger(row.byteSize) || (row.byteSize as number) < 1 || typeof row.contentHash !== "string" || !CONTENT_HASH.test(row.contentHash)) return null;
  return { objectKey: row.objectKey, objectVersionId: row.objectVersionId, byteSize: row.byteSize as number, contentHash: row.contentHash };
}

function headMatches(head: HeadObjectResult, derivative: SafeDerivative): boolean {
  const value = readExactOwnRecord(head, ["contentLength", "contentType", "etag", "versionId", "sha256"]);
  return Boolean(value && value.contentLength === derivative.byteSize && value.contentType === "image/webp" && isRawStorageEtag(value.etag) && value.versionId === derivative.objectVersionId && value.sha256 === derivative.contentHash);
}

async function deleteSource(input: Input, tx: PawketTransaction, candidate: Candidate): Promise<number> {
  const location = { area: "quarantine" as const, key: candidate.targetKey };
  const before = exactVersions(await input.storage!.listObjectVersions(location));
  if (!before) throw new Error("PUBLIC_MEDIA_CLEANUP_STORAGE_INVALID");
  for (const version of before) await input.storage!.deleteObject({ ...location, versionId: version.versionId });
  const after = exactVersions(await input.storage!.listObjectVersions(location));
  if (!after || after.length !== 0) throw new Error("PUBLIC_MEDIA_CLEANUP_STORAGE_INVALID");
  const updated = await tx.update(publicMediaAssets).set({ sourceDeletedAt: input.now, updatedAt: input.now }).where(and(eq(publicMediaAssets.id, candidate.assetId), eq(publicMediaAssets.state, candidate.rule === "processed_source" ? "ready" : "failed"), sql`${publicMediaAssets.sourceDeletedAt} is null`)).returning({ id: publicMediaAssets.id });
  if (updated.length !== 1) throw new Error("PUBLIC_MEDIA_CLEANUP_STATE_CHANGED");
  return before.length > 0 ? candidate.actualSourceBytes ?? 0 : 0;
}

async function readDerivatives(tx: PawketTransaction, assetId: string): Promise<SafeDerivative[]> {
  const rows = await tx.select({ objectKey: publicMediaDerivatives.objectKey, objectVersionId: publicMediaDerivatives.objectVersionId, byteSize: publicMediaDerivatives.byteSize, contentHash: publicMediaDerivatives.contentHash }).from(publicMediaDerivatives).where(eq(publicMediaDerivatives.assetId, assetId)).orderBy(publicMediaDerivatives.variant);
  const derivatives: SafeDerivative[] = [];
  for (const value of rows) {
    const derivative = exactDerivative(value);
    if (!derivative) throw new Error("PUBLIC_MEDIA_CLEANUP_STATE_INVALID");
    derivatives.push(derivative);
  }
  if (derivatives.length !== 4) throw new Error("PUBLIC_MEDIA_CLEANUP_STATE_INVALID");
  return derivatives;
}

async function deleteDerivatives(input: Input, tx: PawketTransaction, candidate: Candidate): Promise<number> {
  const derivatives = await readDerivatives(tx, candidate.assetId);
  let bytesDeleted = 0;
  for (const derivative of derivatives) {
    const location = { area: "derivative" as const, key: derivative.objectKey, versionId: derivative.objectVersionId };
    const before = await input.storage!.headObject(location);
    if (before === null) continue;
    if (!headMatches(before, derivative)) throw new Error("PUBLIC_MEDIA_CLEANUP_STORAGE_INVALID");
    await input.storage!.deleteObject(location);
    if (await input.storage!.headObject(location) !== null) throw new Error("PUBLIC_MEDIA_CLEANUP_STORAGE_INVALID");
    bytesDeleted += derivative.byteSize;
  }
  const updated = await tx.update(publicMediaAssets).set({ state: "deleted", deletionReviewedAt: input.now, updatedAt: input.now }).where(and(eq(publicMediaAssets.id, candidate.assetId), eq(publicMediaAssets.state, "ready"))).returning({ id: publicMediaAssets.id });
  if (updated.length !== 1) throw new Error("PUBLIC_MEDIA_CLEANUP_STATE_CHANGED");
  return bytesDeleted;
}

async function lockOwningCreatorPages(tx: PawketTransaction, assetId: string): Promise<void> {
  await tx.execute(sql`
    select page.id
    from creator_pages page
    join public_media_assets asset on asset.owner_user_id = page.user_id
    where asset.id = ${assetId}
    order by page.id
    for update of page
  `);
}

async function candidateStillEligible(
  tx: PawketTransaction,
  candidate: Candidate,
  now: Date,
): Promise<boolean> {
  const result = await tx.execute(sql`
    with active_draft_refs(asset_id) as (
      select avatar_asset_id from creator_page_drafts where avatar_asset_id is not null
      union select cover_asset_id from creator_page_drafts where cover_asset_id is not null
      union
        select media.asset_id
        from creator_showcase_draft_media media
        join creator_showcase_drafts showcase on showcase.id = media.showcase_id
        where showcase.removed_at is null
    ),
    revision_refs(asset_id, page_id, published_at) as (
      select avatar_asset_id, page_id, published_at from creator_publication_revisions where avatar_asset_id is not null
      union all select cover_asset_id, page_id, published_at from creator_publication_revisions where cover_asset_id is not null
      union all
        select media.asset_id, revision.page_id, revision.published_at
        from creator_publication_media media
        join creator_publication_showcases showcase on showcase.id = media.publication_showcase_id
        join creator_publication_revisions revision on revision.id = showcase.revision_id
    ),
    live_refs(asset_id) as (
      select revision.avatar_asset_id
      from creator_pages page join creator_publication_revisions revision on revision.id = page.published_revision_id
      where revision.avatar_asset_id is not null
      union select revision.cover_asset_id
      from creator_pages page join creator_publication_revisions revision on revision.id = page.published_revision_id
      where revision.cover_asset_id is not null
      union
        select media.asset_id
        from creator_pages page
        join creator_publication_showcases showcase on showcase.revision_id = page.published_revision_id
        join creator_publication_media media on media.publication_showcase_id = showcase.id
    ),
    last_revision_ref as (
      select asset_id, page_id, max(published_at) as last_published_at
      from revision_refs group by asset_id, page_id
    ),
    left_live as (
      select refs.asset_id, min(events.occurred_at) as left_live_at
      from last_revision_ref refs
      join creator_publication_events events
        on events.page_id = refs.page_id and events.occurred_at > refs.last_published_at
      group by refs.asset_id
    ),
    state as (
      select asset.*,
        case
          when page.id is null then asset.ready_at
          when draft.page_id is null then null
          else greatest(
            asset.ready_at,
            page.updated_at,
            draft.updated_at,
            coalesce(showcases.last_changed_at, asset.ready_at)
          )
        end as unreferenced_at
      from public_media_assets asset
      left join creator_pages page on page.user_id = asset.owner_user_id
      left join creator_page_drafts draft on draft.page_id = page.id
      left join lateral (
        select max(greatest(showcase.updated_at, coalesce(showcase.removed_at, showcase.updated_at))) as last_changed_at
        from creator_showcase_drafts showcase
        where showcase.page_id = page.id
      ) showcases on true
      where asset.id = ${candidate.assetId}
    )
    select exists (
      select 1 from state asset
      where
        (${candidate.rule} = 'processed_source' and asset.state = 'ready' and asset.source_deleted_at is null and asset.ready_at + interval '24 hours' <= ${now.toISOString()}::timestamptz)
        or (${candidate.rule} = 'failed_quarantine' and asset.state = 'failed' and asset.source_deleted_at is null and asset.updated_at + interval '7 days' <= ${now.toISOString()}::timestamptz)
        or (${candidate.rule} = 'ready_unreferenced' and asset.state = 'ready' and asset.unreferenced_at is not null and asset.unreferenced_at + interval '30 days' <= ${now.toISOString()}::timestamptz
          and not exists (select 1 from active_draft_refs refs where refs.asset_id = asset.id)
          and not exists (select 1 from revision_refs refs where refs.asset_id = asset.id))
        or (${candidate.rule} = 'superseded_derivative' and asset.state = 'ready'
          and exists (select 1 from left_live where left_live.asset_id = asset.id and left_live.left_live_at + interval '180 days' <= ${now.toISOString()}::timestamptz)
          and not exists (select 1 from active_draft_refs refs where refs.asset_id = asset.id)
          and not exists (select 1 from live_refs refs where refs.asset_id = asset.id)
          and exists (select 1 from revision_refs refs where refs.asset_id = asset.id))
    ) as eligible
  `);
  const row = readExactOwnRecord(result[0], ["eligible"]);
  if (!row || typeof row.eligible !== "boolean") throw new Error("PUBLIC_MEDIA_CLEANUP_QUERY_INVALID");
  return row.eligible;
}

export async function runPublicMediaCleanup(value: Input): Promise<PublicMediaCleanupResult> {
  const input = snapshotInput(value);
  return input.db.transaction(async (tx) => {
    await authorizeEnforcement(input, tx);
    const candidates = await claimCandidates(tx, input.now, input.batchSize);
    const expectedIds = new Set(candidates.map((candidate) => candidate.assetId));
    let protectedIds: ReadonlySet<string> | null = null;
    if ((input.mode === "report_only" || input.globalPause) && input.holds) {
      try {
        protectedIds = exactProtectedIds(await input.holds.protectedAssetIds(tx, [...expectedIds]), expectedIds);
      } catch {
        protectedIds = null;
      }
    } else if (input.mode === "report_only") {
      protectedIds = new Set();
    }
    const counts = emptyCounts();
    const results: Array<{ assetId: string; rule: PublicMediaCleanupRule; eligibleAt: Date; objectKeyHash: string; disposition: PublicMediaCleanupDisposition; bytesDeleted: number }> = [];
    for (const candidate of candidates) {
      let disposition: PublicMediaCleanupDisposition;
      let bytesDeleted = 0;
      if (input.mode === "report_only" || input.globalPause) {
        if (!protectedIds) disposition = "failed";
        else if (protectedIds.has(candidate.assetId)) disposition = "protected";
        else disposition = "candidate";
      } else {
        try {
          await lockOwningCreatorPages(tx, candidate.assetId);
          await acquirePublicMediaRetentionFences(tx, [candidate.assetId]);
          if (!await candidateStillEligible(tx, candidate, input.now)) {
            disposition = "protected";
          } else {
            const exactHolds = exactProtectedIds(
              await input.holds!.protectedAssetIds(tx, [candidate.assetId]),
              new Set([candidate.assetId]),
            );
            if (!exactHolds) throw new Error("PUBLIC_MEDIA_CLEANUP_HOLD_INVALID");
            if (exactHolds.has(candidate.assetId)) {
              disposition = "protected";
            } else {
              bytesDeleted = candidate.rule === "processed_source" || candidate.rule === "failed_quarantine"
                ? await deleteSource(input, tx, candidate)
                : await deleteDerivatives(input, tx, candidate);
              disposition = "processed";
            }
          }
        } catch {
          disposition = "failed";
          bytesDeleted = 0;
        }
      }
      counts[candidate.rule][disposition] += 1;
      results.push({ assetId: candidate.assetId, rule: candidate.rule, eligibleAt: candidate.eligibleAt, objectKeyHash: candidate.objectKeyHash, disposition, bytesDeleted });
    }
    return {
      results,
      counts,
      candidateCount: results.filter((result) => result.disposition === "candidate").length,
      protectedCount: results.filter((result) => result.disposition === "protected").length,
      processedCount: results.filter((result) => result.disposition === "processed").length,
      failedCount: results.filter((result) => result.disposition === "failed").length,
      oldestEligibleAt: results[0]?.eligibleAt ?? null,
    };
  });
}
