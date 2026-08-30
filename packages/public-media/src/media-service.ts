import { randomUUID } from "node:crypto";

import {
  beginIdempotentCommand,
  completeIdempotentCommand,
  insertOutboxEvent,
  publicMediaAssets,
  publicMediaDerivatives,
  publicMediaUploadIntents,
  type PawketDatabase,
  type PawketTransaction,
} from "@pawket/database";
import { createLookupHmac } from "@pawket/security";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import {
  CREATOR_SOURCE_ALLOCATION_BYTES,
  isMediaPurpose,
  isMediaVariant,
  isSourceFormat,
  MAX_SOURCE_BYTES,
  MAX_SOURCE_PIXELS,
  MediaPolicyError,
  isOpaqueVersionId,
  isRawStorageEtag,
  UPLOAD_INTENT_LIFETIME_MS,
  type MediaPurpose,
  type SourceFormat,
} from "./media-policy.js";
import type { CatalogMediaOwnershipPort, CreatorCapabilityPort } from "./media-ports.js";
import type { ObjectStoragePort } from "./object-storage-port.js";
import { readExactNativeArray, readExactOwnRecord } from "./runtime-boundary.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ID_KEY = /^[A-Za-z0-9._-]{8,200}$/u;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,200}$/u;
const MIME_BY_FORMAT: Readonly<Record<SourceFormat, string>> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
const FORMAT_BY_MIME: Readonly<Record<string, SourceFormat>> = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp" };

export type MediaActor = Readonly<{ userId: string }>;
export type { CreatorCapability, CreatorCapabilityPort } from "./media-ports.js";

export type UploadIntentResult = Readonly<{ assetId: string; intentId: string; expiresAt: Date; url: string; requiredHeaders: Record<string, string> }>;
export type CompletedUploadResult = Readonly<{ assetId: string; intentId: string; state: "pending"; sourceObjectVersionId: string; actualSourceBytes: number }>;
export type DeliveryGrant = Readonly<{ location: { area: "derivative"; key: string; versionId: string }; contentLength: number; contentType: "image/webp" }>;
export type ReadyMediaProjection = Readonly<{ assetId: string; ownerUserId: string; purpose: MediaPurpose; derivatives: Readonly<Record<"thumb" | "display" | "large", { derivativeId: string; width: number; height: number }>> }>;
type ReadyMediaRecord = { assetId: string; ownerUserId: string; purpose: MediaPurpose; derivatives: Partial<Record<"thumb" | "display" | "large", { derivativeId: string; width: number; height: number }>> };

type ServiceInput = Readonly<{
  db: PawketDatabase;
  storage: ObjectStoragePort;
  creator: CreatorCapabilityPort;
  catalog: CatalogMediaOwnershipPort;
  publishingMode: "disabled" | "general_audience";
  commandFingerprintKey?: Uint8Array;
  now?: () => Date;
  idFactory?: () => string;
}>;

export type CreateUploadIntentInput = Readonly<{
  actor: MediaActor;
  purpose: MediaPurpose;
  declaredSourceFormat: SourceFormat;
  contentType: string;
  declaredBytes: number;
  idempotencyKey: string;
  requestId: string;
}>;

export type CompleteUploadInput = Readonly<{
  actor: MediaActor;
  assetId: string;
  intentId: string;
  idempotencyKey: string;
  requestId: string;
}>;

export type ResolveReference = Readonly<{ assetId: string; purpose: MediaPurpose; altText?: string | null }>;

export class PublicMediaServiceError extends Error {
  constructor(readonly code: MediaPolicyError["code"]) {
    super(code);
    this.name = "PublicMediaServiceError";
  }
}

function fail(code: MediaPolicyError["code"]): never { throw new PublicMediaServiceError(code); }
function validUuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
function validRequest(value: unknown): value is string { return typeof value === "string" && REQUEST_ID.test(value); }
function snapshotActor(value: unknown): MediaActor | null {
  const actor = readExactOwnRecord(value, ["userId"]);
  return actor && typeof actor.userId === "string" && ID_KEY.test(actor.userId) ? { userId: actor.userId } : null;
}
function snapshotCreateUploadIntent(value: unknown): CreateUploadIntentInput | null {
  const command = readExactOwnRecord(value, ["actor", "purpose", "declaredSourceFormat", "contentType", "declaredBytes", "idempotencyKey", "requestId"]);
  if (!command) return null;
  const actor = snapshotActor(command.actor);
  if (
    !actor ||
    !isMediaPurpose(command.purpose) ||
    !isSourceFormat(command.declaredSourceFormat) ||
    typeof command.contentType !== "string" ||
    FORMAT_BY_MIME[command.contentType] !== command.declaredSourceFormat ||
    !Number.isSafeInteger(command.declaredBytes) ||
    (command.declaredBytes as number) < 1 ||
    (command.declaredBytes as number) > MAX_SOURCE_BYTES ||
    typeof command.idempotencyKey !== "string" ||
    !ID_KEY.test(command.idempotencyKey) ||
    !validRequest(command.requestId)
  ) return null;
  return {
    actor,
    purpose: command.purpose,
    declaredSourceFormat: command.declaredSourceFormat,
    contentType: command.contentType,
    declaredBytes: command.declaredBytes as number,
    idempotencyKey: command.idempotencyKey,
    requestId: command.requestId,
  };
}
function snapshotCompleteUpload(value: unknown): CompleteUploadInput | null {
  const command = readExactOwnRecord(value, ["actor", "assetId", "intentId", "idempotencyKey", "requestId"]);
  if (!command) return null;
  const actor = snapshotActor(command.actor);
  if (
    !actor ||
    !validUuid(command.assetId) ||
    !validUuid(command.intentId) ||
    typeof command.idempotencyKey !== "string" ||
    !ID_KEY.test(command.idempotencyKey) ||
    !validRequest(command.requestId)
  ) return null;
  return { actor, assetId: command.assetId, intentId: command.intentId, idempotencyKey: command.idempotencyKey, requestId: command.requestId };
}
function snapshotResolveReference(value: unknown): ResolveReference | null {
  const reference = readExactOwnRecord(value, ["assetId", "purpose"], ["altText"]);
  if (
    !reference ||
    !validUuid(reference.assetId) ||
    !isMediaPurpose(reference.purpose) ||
    ("altText" in reference && reference.altText !== undefined && reference.altText !== null && typeof reference.altText !== "string")
  ) return null;
  return {
    assetId: reference.assetId,
    purpose: reference.purpose,
    ...("altText" in reference ? { altText: reference.altText as string | null | undefined } : {}),
  };
}
function snapshotResolveReferences(value: unknown): ResolveReference[] | null {
  const values = readExactNativeArray(value);
  if (!values) return null;
  const references: ResolveReference[] = [];
  for (const candidate of values) {
    const reference = snapshotResolveReference(candidate);
    if (!reference) return null;
    references.push(reference);
  }
  return references;
}
function snapshotResolveBatchRequest(value: unknown): { ownerUserId: string; references: ResolveReference[] } | null {
  const request = readExactOwnRecord(value, ["ownerUserId", "references"]);
  if (!request || typeof request.ownerUserId !== "string" || !ID_KEY.test(request.ownerUserId)) return null;
  const references = snapshotResolveReferences(request.references);
  return references ? { ownerUserId: request.ownerUserId, references } : null;
}
function exactActiveCreator(value: unknown, userId: string): boolean {
  const creator = readExactOwnRecord(value, ["userId", "state"]);
  return Boolean(creator && creator.userId === userId && creator.state === "active");
}
function mapStorageError(error: unknown): never {
  if (error instanceof PublicMediaServiceError) throw error;
  if (error instanceof MediaPolicyError) fail(error.code);
  fail("STORAGE_UNAVAILABLE");
}
function parseIntentReference(value: string): { assetId: string; intentId: string } | null {
  const match = /^media-upload-v1:([0-9a-f-]{36}):([0-9a-f-]{36})$/u.exec(value);
  return match && validUuid(match[1]) && validUuid(match[2]) ? { assetId: match[1], intentId: match[2] } : null;
}
function parseCompletionReference(value: string): { assetId: string; intentId: string; actualSourceBytes: number } | null {
  const match = /^media-complete-v2:([0-9a-f-]{36}):([0-9a-f-]{36}):(\d{1,16})$/u.exec(value);
  if (!match || !validUuid(match[1]) || !validUuid(match[2])) return null;
  const bytes = Number(match[3]);
  return Number.isSafeInteger(bytes) && bytes > 0 && bytes <= MAX_SOURCE_BYTES ? { assetId: match[1], intentId: match[2], actualSourceBytes: bytes } : null;
}
export function createPublicMediaService(input: ServiceInput) {
  const now = input.now ?? (() => new Date());
  const id = input.idFactory ?? randomUUID;
  const fingerprintKey = input.commandFingerprintKey ?? new Uint8Array(32).fill(71);
  const activePort = input.creator;

  async function requireActiveCreator(db: PawketDatabase | PawketTransaction, userId: string): Promise<void> {
    if (!activePort) fail("MEDIA_NOT_OWNER");
    const result = await activePort.getActiveCreator(db, userId);
    if (!exactActiveCreator(result, userId)) fail("MEDIA_NOT_OWNER");
  }

  async function requireOwnedCatalogAsset(db: PawketDatabase | PawketTransaction, userId: string, assetId: string, purpose: MediaPurpose): Promise<void> {
    if (!input.catalog || typeof input.catalog.ownsAsset !== "function") fail("MEDIA_NOT_OWNER");
    if (await input.catalog.ownsAsset(db, userId, assetId, purpose) !== true) fail("MEDIA_NOT_OWNER");
  }

  function fingerprint(value: unknown): string {
    return createLookupHmac({ value: JSON.stringify(value), context: "public-media-command", key: fingerprintKey });
  }

  async function createUploadIntent(command: CreateUploadIntentInput): Promise<UploadIntentResult> {
    if (input.publishingMode !== "general_audience") fail("PUBLISHING_DISABLED");
    const safeCommand = snapshotCreateUploadIntent(command);
    if (!safeCommand) fail("INVALID_INPUT");
    const format = safeCommand.declaredSourceFormat;
    const contentType = safeCommand.contentType;
    const safeDeclaredBytes = safeCommand.declaredBytes;
    const at = now();
    const intentId = id();
    const assetId = id();
    if (!validUuid(intentId) || !validUuid(assetId)) fail("INVALID_INPUT");
    const objectKey = `quarantine/${assetId}/${intentId}`;
    try {
      return await input.db.transaction(async (tx) => {
        await requireActiveCreator(tx, safeCommand.actor.userId);
        const expiresAt = new Date(at.getTime() + UPLOAD_INTENT_LIFETIME_MS);
        let idempotencyRecordId: string | undefined;
        if (safeCommand.idempotencyKey) {
          const started = await beginIdempotentCommand(tx, { actorUserId: safeCommand.actor.userId, commandScope: "public-media.upload-intent", keyHash: createLookupHmac({ value: safeCommand.idempotencyKey, context: "public-media-command-key", key: fingerprintKey }), requestFingerprint: fingerprint({ purpose: safeCommand.purpose, format, declaredBytes: safeDeclaredBytes, requestId: safeCommand.requestId }), expiresAt, now: at });
          if (started.kind === "replay") {
            const replay = parseIntentReference(started.resultReference);
            if (!replay) fail("IDEMPOTENCY_CONFLICT");
            const [existing] = await tx.select().from(publicMediaUploadIntents).where(and(eq(publicMediaUploadIntents.id, replay.intentId), eq(publicMediaUploadIntents.assetId, replay.assetId), eq(publicMediaUploadIntents.ownerUserId, safeCommand.actor.userId))).limit(1);
            if (!existing || existing.state !== "issued") fail("IDEMPOTENCY_CONFLICT");
            const remainingSeconds = Math.min(900, Math.floor((existing.expiresAt.getTime() - at.getTime()) / 1000));
            if (!Number.isInteger(remainingSeconds) || remainingSeconds < 1) fail("UPLOAD_EXPIRED");
            const replayGrant = await input.storage.presignPut({ key: existing.objectKey, contentType, contentLength: existing.maxSourceBytes, expiresInSeconds: remainingSeconds });
            if (!(replayGrant.expiresAt instanceof Date) || !Number.isFinite(replayGrant.expiresAt.getTime()) || replayGrant.expiresAt.getTime() <= at.getTime() || replayGrant.expiresAt.getTime() > existing.expiresAt.getTime()) fail("STORAGE_ERROR");
            return { assetId: replay.assetId, intentId: replay.intentId, expiresAt: existing.expiresAt, url: replayGrant.url, requiredHeaders: { ...replayGrant.requiredHeaders } };
          }
          if (started.kind === "expired") fail("UPLOAD_EXPIRED");
          if (started.kind !== "acquired") fail("IDEMPOTENCY_CONFLICT");
          idempotencyRecordId = started.recordId;
        }
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`public-media-quota:${safeCommand.actor.userId}`}, 0))`);
        const [allocated] = await tx.select({ total: sql<number>`coalesce(sum(${publicMediaAssets.sourceAllocationBytes}), 0)` }).from(publicMediaAssets).where(and(eq(publicMediaAssets.ownerUserId, safeCommand.actor.userId), isNull(publicMediaAssets.sourceDeletedAt), inArray(publicMediaAssets.state, ["awaiting_upload", "pending", "processing", "ready", "failed"])));
        if (Number(allocated?.total ?? 0) + safeDeclaredBytes > CREATOR_SOURCE_ALLOCATION_BYTES) fail("MEDIA_QUOTA_EXCEEDED");
        await tx.insert(publicMediaAssets).values({ id: assetId, ownerUserId: safeCommand.actor.userId, purpose: safeCommand.purpose, declaredSourceFormat: format, state: "awaiting_upload", sourceAllocationBytes: safeDeclaredBytes, sourceObjectKey: objectKey, sourceObjectVersionId: null, sourceObjectEtag: null, normalizedMasterObjectKey: null, normalizedMasterObjectVersionId: null, actualSourceBytes: null, sourceDeletedAt: null, width: null, height: null, failureCode: null, readyAt: null, deletionReviewedAt: null, createdAt: at, updatedAt: at });
        await tx.insert(publicMediaUploadIntents).values({ id: intentId, assetId, ownerUserId: safeCommand.actor.userId, purpose: safeCommand.purpose, declaredSourceFormat: format, maxSourceBytes: safeDeclaredBytes, maxSourcePixels: MAX_SOURCE_PIXELS, objectKey, state: "issued", expiresAt, completedAt: null, createdAt: at, updatedAt: at });
        const storageGrant = await input.storage.presignPut({ key: objectKey, contentType, contentLength: safeDeclaredBytes, expiresInSeconds: 900 });
        if (!storageGrant.expiresAt || storageGrant.expiresAt.getTime() !== expiresAt.getTime()) fail("STORAGE_ERROR");
        if (idempotencyRecordId) {
          if (!await completeIdempotentCommand(tx, { recordId: idempotencyRecordId, resultReference: `media-upload-v1:${assetId}:${intentId}`, completedAt: at })) fail("IDEMPOTENCY_CONFLICT");
        }
        return { assetId, intentId, expiresAt, url: storageGrant.url, requiredHeaders: { ...storageGrant.requiredHeaders } };
      });
    } catch (error) { return mapStorageError(error); }
  }

  async function completeUpload(command: CompleteUploadInput): Promise<CompletedUploadResult> {
    const safeCommand = snapshotCompleteUpload(command);
    if (!safeCommand) fail("INVALID_INPUT");
    const at = now();
    try {
      return await input.db.transaction(async (tx) => {
        const [asset] = await tx.select().from(publicMediaAssets).where(and(eq(publicMediaAssets.id, safeCommand.assetId), eq(publicMediaAssets.ownerUserId, safeCommand.actor.userId))).limit(1).for("update");
        if (!asset) fail("MEDIA_NOT_FOUND");
        const [intent] = await tx.select().from(publicMediaUploadIntents).where(and(eq(publicMediaUploadIntents.assetId, asset.id), eq(publicMediaUploadIntents.ownerUserId, safeCommand.actor.userId))).limit(1).for("update");
        if (!intent || intent.id !== safeCommand.intentId) fail("MEDIA_NOT_FOUND");
        // Capability and consumer-owned Catalog authorization are required before
        // consulting idempotency, including completed replays while publishing is
        // disabled.  This keeps replay from becoming an authorization bypass.
        await requireActiveCreator(tx, safeCommand.actor.userId);
        await requireOwnedCatalogAsset(tx, safeCommand.actor.userId, asset.id, asset.purpose as MediaPurpose);
        let idempotencyRecordId: string | undefined;
        if (safeCommand.idempotencyKey) {
          const started = await beginIdempotentCommand(tx, { actorUserId: safeCommand.actor.userId, commandScope: "public-media.upload-complete", keyHash: createLookupHmac({ value: safeCommand.idempotencyKey, context: "public-media-command-key", key: fingerprintKey }), requestFingerprint: fingerprint({ assetId: asset.id, intentId: intent.id, requestId: safeCommand.requestId }), expiresAt: new Date(at.getTime() + 24 * 60 * 60_000), now: at });
          if (started.kind === "replay") {
            const replay = parseCompletionReference(started.resultReference);
            if (!replay || replay.assetId !== asset.id || replay.intentId !== intent.id || intent.state !== "completed" || !isOpaqueVersionId(asset.sourceObjectVersionId) || replay.actualSourceBytes !== asset.actualSourceBytes) fail("IDEMPOTENCY_CONFLICT");
            return { assetId: asset.id, intentId: intent.id, state: "pending", sourceObjectVersionId: asset.sourceObjectVersionId, actualSourceBytes: asset.actualSourceBytes };
          }
          if (started.kind !== "acquired") fail("IDEMPOTENCY_CONFLICT");
          idempotencyRecordId = started.recordId;
        }
        if (input.publishingMode !== "general_audience") fail("PUBLISHING_DISABLED");
        // A completed intent is immutable, but only its recorded idempotency
        // command can replay it. A fresh key must not mint another state row.
        if (intent.state === "completed" && asset.sourceObjectVersionId && asset.actualSourceBytes) {
          fail("UPLOAD_NOT_READY");
        }
        if (asset.state !== "awaiting_upload" || intent.state !== "issued") fail("UPLOAD_NOT_READY");
        if (at.getTime() >= intent.expiresAt.getTime()) fail("UPLOAD_EXPIRED");
        if (intent.objectKey !== asset.sourceObjectKey) fail("UPLOAD_CONTENT_INVALID");
        const head = await input.storage.headObject({ area: "quarantine", key: intent.objectKey });
        if (!head || !isOpaqueVersionId(head.versionId) || !isRawStorageEtag(head.etag) || !Number.isSafeInteger(head.contentLength) || head.contentLength <= 0 || head.contentLength !== asset.sourceAllocationBytes || head.contentLength !== intent.maxSourceBytes || head.contentLength > MAX_SOURCE_BYTES || head.contentType !== MIME_BY_FORMAT[asset.declaredSourceFormat as SourceFormat]) fail("UPLOAD_CONTENT_INVALID");
        await tx.update(publicMediaUploadIntents).set({ state: "completed", completedAt: at, updatedAt: at }).where(eq(publicMediaUploadIntents.id, intent.id));
        await tx.update(publicMediaAssets).set({ state: "pending", sourceObjectVersionId: head.versionId, sourceObjectEtag: head.etag, actualSourceBytes: head.contentLength, updatedAt: at }).where(and(eq(publicMediaAssets.id, asset.id), eq(publicMediaAssets.state, "awaiting_upload")));
        const result: CompletedUploadResult = { assetId: asset.id, intentId: intent.id, state: "pending", sourceObjectVersionId: head.versionId, actualSourceBytes: head.contentLength };
        await insertOutboxEvent(tx, { eventType: "media.public_upload_completed.v1", eventVersion: 1, aggregateType: "public_media_asset", aggregateId: asset.id, payload: { assetId: asset.id, ownerUserId: asset.ownerUserId, purpose: asset.purpose }, occurredAt: at });
        if (idempotencyRecordId && !await completeIdempotentCommand(tx, { recordId: idempotencyRecordId, resultReference: `media-complete-v2:${result.assetId}:${result.intentId}:${result.actualSourceBytes}`, completedAt: at })) fail("IDEMPOTENCY_CONFLICT");
        return result;
      });
    } catch (error) { return mapStorageError(error); }
  }

  async function resolveReadyAssets(db: PawketDatabase | PawketTransaction, ownerUserId: string, references: readonly ResolveReference[]): Promise<ReadonlyMap<string, ReadyMediaProjection>> {
    if (typeof ownerUserId !== "string" || !ID_KEY.test(ownerUserId)) return new Map();
    const resolvedReferences = snapshotResolveReferences(references);
    if (!resolvedReferences || resolvedReferences.length === 0) return new Map();
    const ids = [...new Set(resolvedReferences.map((r) => r.assetId))];
    if (ids.length === 0) return new Map();
    const rows = await db.select({ assetId: publicMediaAssets.id, ownerUserId: publicMediaAssets.ownerUserId, purpose: publicMediaAssets.purpose, derivativeId: publicMediaDerivatives.id, variant: publicMediaDerivatives.variant, width: publicMediaDerivatives.width, height: publicMediaDerivatives.height }).from(publicMediaAssets).innerJoin(publicMediaDerivatives, eq(publicMediaDerivatives.assetId, publicMediaAssets.id)).where(and(inArray(publicMediaAssets.id, ids), eq(publicMediaAssets.ownerUserId, ownerUserId), eq(publicMediaAssets.state, "ready"), inArray(publicMediaDerivatives.variant, ["thumb", "display", "large"])));
    const byId = new Map<string, { assetId: string; ownerUserId: string; purpose: MediaPurpose; derivatives: Record<"thumb" | "display" | "large", { derivativeId: string; width: number; height: number }> }>();
    for (const row of rows) {
      if (!isMediaPurpose(row.purpose) || !isMediaVariant(row.variant) || row.variant === "master") continue;
      const current = byId.get(row.assetId) ?? { assetId: row.assetId, ownerUserId: row.ownerUserId, purpose: row.purpose, derivatives: {} as Record<"thumb" | "display" | "large", { derivativeId: string; width: number; height: number }> };
      current.derivatives[row.variant] = { derivativeId: row.derivativeId, width: row.width, height: row.height };
      byId.set(row.assetId, current);
    }
    const result = new Map<string, ReadyMediaProjection>();
    for (const reference of resolvedReferences) {
      const value = byId.get(reference.assetId);
      if (!value || value.purpose !== reference.purpose || !value.derivatives.thumb || !value.derivatives.display || !value.derivatives.large) continue;
      result.set(reference.assetId, { assetId: value.assetId, ownerUserId: value.ownerUserId, purpose: value.purpose, derivatives: { thumb: value.derivatives.thumb, display: value.derivatives.display, large: value.derivatives.large } });
    }
    return result;
  }

  async function resolveReadyAssetsBatch(db: PawketDatabase | PawketTransaction, requests: readonly Readonly<{ ownerUserId: string; references: readonly ResolveReference[] }>[]): Promise<ReadonlyMap<string, ReadonlyMap<string, ReadyMediaProjection>>> {
    const result = new Map<string, Map<string, ReadyMediaProjection>>();
    const requestValues = readExactNativeArray(requests);
    if (!requestValues || requestValues.length === 0) return result;
    const resolvedRequests: { ownerUserId: string; references: ResolveReference[] }[] = [];
    for (const candidate of requestValues) {
      const request = snapshotResolveBatchRequest(candidate);
      if (!request) return result;
      resolvedRequests.push(request);
    }
    const owners = [...new Set(resolvedRequests.map((r) => r.ownerUserId))];
    const ids = [...new Set(resolvedRequests.flatMap((r) => r.references).map((r) => r.assetId))];
    for (const ownerUserId of owners) result.set(ownerUserId, new Map());
    if (owners.length === 0 || ids.length === 0) return result;
    const rows = await db.select({ assetId: publicMediaAssets.id, ownerUserId: publicMediaAssets.ownerUserId, purpose: publicMediaAssets.purpose, derivativeId: publicMediaDerivatives.id, variant: publicMediaDerivatives.variant, width: publicMediaDerivatives.width, height: publicMediaDerivatives.height }).from(publicMediaAssets).innerJoin(publicMediaDerivatives, eq(publicMediaDerivatives.assetId, publicMediaAssets.id)).where(and(inArray(publicMediaAssets.id, ids), inArray(publicMediaAssets.ownerUserId, owners), eq(publicMediaAssets.state, "ready"), inArray(publicMediaDerivatives.variant, ["thumb", "display", "large"])));
    const all = new Map<string, Map<string, ReadyMediaRecord>>();
    for (const row of rows) {
      if (!isMediaPurpose(row.purpose) || !isMediaVariant(row.variant) || row.variant === "master") continue;
      const owner = all.get(row.ownerUserId) ?? new Map();
      const current = owner.get(row.assetId) ?? { assetId: row.assetId, ownerUserId: row.ownerUserId, purpose: row.purpose, derivatives: {} };
      current.derivatives[row.variant] = { derivativeId: row.derivativeId, width: row.width, height: row.height };
      owner.set(row.assetId, current); all.set(row.ownerUserId, owner);
    }
    for (const request of resolvedRequests) {
      const source = all.get(request.ownerUserId) ?? new Map();
      const out = new Map<string, ReadyMediaProjection>();
      for (const ref of request.references) {
        const value = source.get(ref.assetId);
        if (value && value.purpose === ref.purpose && value.derivatives.thumb && value.derivatives.display && value.derivatives.large) out.set(ref.assetId, { assetId: value.assetId, ownerUserId: value.ownerUserId, purpose: value.purpose, derivatives: { thumb: value.derivatives.thumb, display: value.derivatives.display, large: value.derivatives.large } });
      }
      result.set(request.ownerUserId, out);
    }
    return result;
  }

  async function getDeliveryGrant(command: Readonly<{ assetId: string; variant: "thumb" | "display" | "large" }>): Promise<DeliveryGrant> {
    const safeCommand = readExactOwnRecord(command, ["assetId", "variant"]);
    if (!safeCommand || !validUuid(safeCommand.assetId) || !["thumb", "display", "large"].includes(safeCommand.variant as string) || !isMediaVariant(safeCommand.variant) || safeCommand.variant === "master") fail("INVALID_INPUT");
    const [row] = await input.db.select({ objectKey: publicMediaDerivatives.objectKey, objectVersionId: publicMediaDerivatives.objectVersionId, byteSize: publicMediaDerivatives.byteSize }).from(publicMediaDerivatives).innerJoin(publicMediaAssets, eq(publicMediaAssets.id, publicMediaDerivatives.assetId)).where(and(eq(publicMediaDerivatives.assetId, safeCommand.assetId), eq(publicMediaDerivatives.variant, safeCommand.variant), eq(publicMediaAssets.state, "ready"))).limit(1);
    if (!row || !row.objectKey || !isOpaqueVersionId(row.objectVersionId) || !Number.isSafeInteger(row.byteSize) || row.byteSize < 1) fail("MEDIA_NOT_READY");
    return { location: { area: "derivative", key: row.objectKey, versionId: row.objectVersionId }, contentLength: row.byteSize, contentType: "image/webp" };
  }

  return { createUploadIntent, completeUpload, resolveReadyAssets, resolveReadyAssetsBatch, getDeliveryGrant };
}
