import { randomUUID } from "node:crypto";

import {
  insertOutboxEvent,
  publicMediaAssets,
  publicMediaDerivatives,
  publicMediaProcessingAttempts,
  type PawketDatabase,
} from "@pawket/database";
import { and, desc, eq } from "drizzle-orm";

import {
  isOpaqueVersionId,
  isRawStorageEtag,
  MAX_SOURCE_BYTES,
  MediaPolicyError,
} from "./media-policy.js";
import {
  processPublicImage,
  PublicImageProcessingError,
  type ProcessedPublicImage,
  type PublicImageOutput,
} from "./image-processor.js";
import {
  ObjectStorageConflictError,
  type HeadObjectResult,
  type ObjectStoragePort,
} from "./object-storage-port.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WORKER_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const PROCESSING_LEASE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 8;

export type MediaProcessingCheckpoint =
  | "after_claim"
  | "after_master_put"
  | "after_derivatives_put"
  | "before_ready_commit";

export type ProcessPublicMediaAssetOptions = Readonly<{
  workerId?: string;
  now?: () => Date;
  idFactory?: () => string;
  checkpoint?: (stage: MediaProcessingCheckpoint) => Promise<void> | void;
  processImage?: typeof processPublicImage;
}>;

export type ProcessPublicMediaAssetResult = Readonly<{
  assetId: string;
  state: "ready" | "failed" | "ignored";
  failureCode?: string;
}>;

export class PublicMediaWorkerRetryableError extends Error {
  constructor(
    readonly code:
      | "processing_lease_active"
      | "attempt_fenced"
      | "storage_unavailable"
      | "storage_error",
  ) {
    super(code);
    this.name = "PublicMediaWorkerRetryableError";
  }
}

class PublicMediaWorkerTerminalError extends Error {
  constructor(readonly code: "failed_validation" | "derivative_key_conflict") {
    super(code);
    this.name = "PublicMediaWorkerTerminalError";
  }
}

type ClaimedAsset = Readonly<{
  kind: "claimed";
  assetId: string;
  attemptId: string;
  attemptNumber: number;
  sourceKey: string;
  sourceVersionId: string;
  sourceEtag: string;
  actualSourceBytes: number;
  declaredSourceFormat: "jpeg" | "png" | "webp";
}>;

type SettledAsset = Readonly<{
  kind: "settled";
  result: ProcessPublicMediaAssetResult;
}>;

type StoredDerivative = Readonly<{
  output: PublicImageOutput;
  key: string;
  versionId: string;
}>;

function retryable(code: PublicMediaWorkerRetryableError["code"]): never {
  throw new PublicMediaWorkerRetryableError(code);
}

function validateInput(assetId: unknown, options: ProcessPublicMediaAssetOptions): { workerId: string } {
  const workerId = options.workerId ?? `media-worker:${randomUUID()}`;
  if (typeof assetId !== "string" || !UUID.test(assetId) || !WORKER_ID.test(workerId)) {
    throw new Error("Invalid public media worker input");
  }
  return { workerId };
}

async function claimAsset(
  db: PawketDatabase,
  assetId: string,
  workerId: string,
  at: Date,
  idFactory: () => string,
): Promise<ClaimedAsset | SettledAsset> {
  return db.transaction(async (tx) => {
    const [asset] = await tx
      .select()
      .from(publicMediaAssets)
      .where(eq(publicMediaAssets.id, assetId))
      .limit(1)
      .for("update");
    if (!asset) return { kind: "settled", result: { assetId, state: "ignored" } };
    if (asset.state === "ready") return { kind: "settled", result: { assetId, state: "ready" } };
    if (asset.state === "failed") {
      return {
        kind: "settled",
        result: { assetId, state: "failed", failureCode: asset.failureCode ?? "processing_error" },
      };
    }
    if (asset.state === "deleted" || asset.state === "awaiting_upload") {
      return { kind: "settled", result: { assetId, state: "ignored" } };
    }
    if (
      !isOpaqueVersionId(asset.sourceObjectVersionId) ||
      !isRawStorageEtag(asset.sourceObjectEtag) ||
      !Number.isSafeInteger(asset.actualSourceBytes) ||
      asset.actualSourceBytes === null ||
      asset.actualSourceBytes < 1 ||
      asset.actualSourceBytes > MAX_SOURCE_BYTES ||
      (asset.declaredSourceFormat !== "jpeg" &&
        asset.declaredSourceFormat !== "png" &&
        asset.declaredSourceFormat !== "webp")
    ) {
      throw new Error("Invalid pinned public media state");
    }
    const [latest] = await tx
      .select()
      .from(publicMediaProcessingAttempts)
      .where(eq(publicMediaProcessingAttempts.assetId, assetId))
      .orderBy(desc(publicMediaProcessingAttempts.attemptNumber))
      .limit(1)
      .for("update");

    if (asset.state === "processing" && latest?.finishedAt === null) {
      const leaseExpiresAt = latest.startedAt.getTime() + PROCESSING_LEASE_MS;
      if (leaseExpiresAt > at.getTime()) {
        retryable("processing_lease_active");
      }
      if (latest.attemptNumber >= MAX_ATTEMPTS) {
        await tx
          .update(publicMediaProcessingAttempts)
          .set({ outcomeCode: "processing_error", finishedAt: at, nextRetryAt: null, updatedAt: at })
          .where(eq(publicMediaProcessingAttempts.id, latest.id));
        await tx
          .update(publicMediaAssets)
          .set({ state: "failed", failureCode: "processing_error", updatedAt: at })
          .where(eq(publicMediaAssets.id, assetId));
        await insertOutboxEvent(tx, {
          eventType: "media.public_asset_failed.v1",
          eventVersion: 1,
          aggregateType: "public_media_asset",
          aggregateId: assetId,
          payload: { assetId, failureCode: "processing_error" },
          occurredAt: at,
        });
        return {
          kind: "settled",
          result: { assetId, state: "failed", failureCode: "processing_error" },
        };
      }
      await tx
        .update(publicMediaProcessingAttempts)
        .set({ outcomeCode: "retryable", finishedAt: at, nextRetryAt: at, updatedAt: at })
        .where(eq(publicMediaProcessingAttempts.id, latest.id));
    }

    const attemptNumber = (latest?.attemptNumber ?? 0) + 1;
    if (attemptNumber > MAX_ATTEMPTS) {
      await tx
        .update(publicMediaAssets)
        .set({ state: "failed", failureCode: "processing_error", updatedAt: at })
        .where(eq(publicMediaAssets.id, assetId));
      await insertOutboxEvent(tx, {
        eventType: "media.public_asset_failed.v1",
        eventVersion: 1,
        aggregateType: "public_media_asset",
        aggregateId: assetId,
        payload: { assetId, failureCode: "processing_error" },
        occurredAt: at,
      });
      return {
        kind: "settled",
        result: { assetId, state: "failed", failureCode: "processing_error" },
      };
    }
    const attemptId = idFactory();
    if (!UUID.test(attemptId)) throw new Error("Invalid media processing attempt ID");
    await tx
      .update(publicMediaAssets)
      .set({ state: "processing", failureCode: null, updatedAt: at })
      .where(eq(publicMediaAssets.id, assetId));
    await tx.insert(publicMediaProcessingAttempts).values({
      id: attemptId,
      assetId,
      attemptNumber,
      workerId,
      outcomeCode: "started",
      startedAt: at,
      finishedAt: null,
      nextRetryAt: null,
      createdAt: at,
      updatedAt: at,
    });
    return {
      kind: "claimed",
      assetId,
      attemptId,
      attemptNumber,
      sourceKey: asset.sourceObjectKey,
      sourceVersionId: asset.sourceObjectVersionId,
      sourceEtag: asset.sourceObjectEtag,
      actualSourceBytes: asset.actualSourceBytes,
      declaredSourceFormat: asset.declaredSourceFormat,
    };
  });
}

function sourceContentType(format: ClaimedAsset["declaredSourceFormat"]): string {
  if (format === "jpeg") return "image/jpeg";
  if (format === "png") return "image/png";
  return "image/webp";
}

function exactPinnedSource(head: HeadObjectResult | null, claimed: ClaimedAsset): boolean {
  return Boolean(
    head &&
      head.versionId === claimed.sourceVersionId &&
      head.etag === claimed.sourceEtag &&
      head.contentLength === claimed.actualSourceBytes &&
      head.contentType === sourceContentType(claimed.declaredSourceFormat),
  );
}

async function boundedBytes(stream: NodeJS.ReadableStream, expectedBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<unknown>) {
    if (!(chunk instanceof Uint8Array)) throw new PublicMediaWorkerTerminalError("failed_validation");
    total += chunk.byteLength;
    if (total > MAX_SOURCE_BYTES || total > expectedBytes) {
      const destroy = (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy;
      if (typeof destroy === "function") destroy.call(stream);
      throw new PublicMediaWorkerTerminalError("failed_validation");
    }
    chunks.push(Uint8Array.from(chunk));
  }
  if (total !== expectedBytes) throw new PublicMediaWorkerTerminalError("failed_validation");
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function derivativeKey(assetId: string, output: PublicImageOutput): string {
  return `derivatives/${assetId}/${output.variant}/${output.sha256.slice("sha256:v1:".length)}.webp`;
}

function matchesDerivative(head: HeadObjectResult | null, output: PublicImageOutput): head is HeadObjectResult & { versionId: string } {
  return Boolean(
    head &&
      head.contentLength === output.byteSize &&
      head.contentType === "image/webp" &&
      head.sha256 === output.sha256 &&
      isOpaqueVersionId(head.versionId),
  );
}

async function ensureDerivativeVersion(
  storage: ObjectStoragePort,
  assetId: string,
  output: PublicImageOutput,
): Promise<StoredDerivative> {
  const key = derivativeKey(assetId, output);
  const current = await storage.headObject({ area: "derivative", key });
  if (current) {
    if (!matchesDerivative(current, output)) {
      throw new PublicMediaWorkerTerminalError("derivative_key_conflict");
    }
    return { output, key, versionId: current.versionId };
  }
  try {
    const created = await storage.putObject({
      area: "derivative",
      key,
      contentType: "image/webp",
      body: output.bytes,
      sha256: output.sha256,
      createOnly: true,
    });
    return { output, key, versionId: created.versionId };
  } catch (error) {
    if (!(error instanceof ObjectStorageConflictError)) throw error;
    const winner = await storage.headObject({ area: "derivative", key });
    if (!winner) retryable("storage_unavailable");
    if (!matchesDerivative(winner, output)) {
      throw new PublicMediaWorkerTerminalError("derivative_key_conflict");
    }
    return { output, key, versionId: winner.versionId };
  }
}

type TerminalFailureCode =
  | "failed_validation"
  | "unsupported_format"
  | "malformed_image"
  | "dimensions_exceeded"
  | "output_too_large"
  | "derivative_key_conflict";

async function finalizeFailure(
  db: PawketDatabase,
  claimed: ClaimedAsset,
  failureCode: TerminalFailureCode | "storage_error" | "processing_error",
  attemptOutcome: string,
  at: Date,
): Promise<ProcessPublicMediaAssetResult> {
  return db.transaction(async (tx) => {
    const [asset] = await tx
      .select({ state: publicMediaAssets.state, failureCode: publicMediaAssets.failureCode })
      .from(publicMediaAssets)
      .where(eq(publicMediaAssets.id, claimed.assetId))
      .limit(1)
      .for("update");
    if (!asset) return { assetId: claimed.assetId, state: "ignored" };
    const [latest] = await tx
      .select({ id: publicMediaProcessingAttempts.id, finishedAt: publicMediaProcessingAttempts.finishedAt })
      .from(publicMediaProcessingAttempts)
      .where(eq(publicMediaProcessingAttempts.assetId, claimed.assetId))
      .orderBy(desc(publicMediaProcessingAttempts.attemptNumber))
      .limit(1)
      .for("update");
    if (asset.state !== "processing" || latest?.id !== claimed.attemptId || latest.finishedAt !== null) {
      retryable("attempt_fenced");
    }
    await tx
      .update(publicMediaProcessingAttempts)
      .set({ outcomeCode: attemptOutcome, finishedAt: at, nextRetryAt: null, updatedAt: at })
      .where(
        and(
          eq(publicMediaProcessingAttempts.id, claimed.attemptId),
          eq(publicMediaProcessingAttempts.assetId, claimed.assetId),
        ),
      );
    await tx
      .update(publicMediaAssets)
      .set({ state: "failed", failureCode, updatedAt: at })
      .where(eq(publicMediaAssets.id, claimed.assetId));
    await insertOutboxEvent(tx, {
      eventType: "media.public_asset_failed.v1",
      eventVersion: 1,
      aggregateType: "public_media_asset",
      aggregateId: claimed.assetId,
      payload: { assetId: claimed.assetId, failureCode },
      occurredAt: at,
    });
    return { assetId: claimed.assetId, state: "failed", failureCode };
  });
}

async function recordRetryableFailure(
  db: PawketDatabase,
  claimed: ClaimedAsset,
  error: unknown,
  terminalFailureCode: "storage_error" | "processing_error",
  at: Date,
): Promise<ProcessPublicMediaAssetResult | null> {
  if (claimed.attemptNumber >= MAX_ATTEMPTS) {
    return finalizeFailure(db, claimed, terminalFailureCode, terminalFailureCode, at);
  }
  await db.transaction(async (tx) => {
    const [asset] = await tx
      .select({ state: publicMediaAssets.state })
      .from(publicMediaAssets)
      .where(eq(publicMediaAssets.id, claimed.assetId))
      .limit(1)
      .for("update");
    if (!asset || asset.state !== "processing") return;
    const [latest] = await tx
      .select({ id: publicMediaProcessingAttempts.id, finishedAt: publicMediaProcessingAttempts.finishedAt })
      .from(publicMediaProcessingAttempts)
      .where(eq(publicMediaProcessingAttempts.assetId, claimed.assetId))
      .orderBy(desc(publicMediaProcessingAttempts.attemptNumber))
      .limit(1)
      .for("update");
    if (latest?.id !== claimed.attemptId || latest.finishedAt !== null) {
      retryable("attempt_fenced");
    }
    await tx
      .update(publicMediaProcessingAttempts)
      .set({ outcomeCode: "retryable_error", finishedAt: at, nextRetryAt: at, updatedAt: at })
      .where(eq(publicMediaProcessingAttempts.id, claimed.attemptId));
    await tx
      .update(publicMediaAssets)
      .set({ state: "pending", updatedAt: at })
      .where(eq(publicMediaAssets.id, claimed.assetId));
  });
  throw error;
}

async function finalizeReady(
  db: PawketDatabase,
  claimed: ClaimedAsset,
  processed: ProcessedPublicImage,
  derivatives: readonly StoredDerivative[],
  at: Date,
  idFactory: () => string,
): Promise<ProcessPublicMediaAssetResult> {
  return db.transaction(async (tx) => {
    const [asset] = await tx
      .select({ state: publicMediaAssets.state })
      .from(publicMediaAssets)
      .where(eq(publicMediaAssets.id, claimed.assetId))
      .limit(1)
      .for("update");
    if (!asset) return { assetId: claimed.assetId, state: "ignored" };
    const [latest] = await tx
      .select({ id: publicMediaProcessingAttempts.id, finishedAt: publicMediaProcessingAttempts.finishedAt })
      .from(publicMediaProcessingAttempts)
      .where(eq(publicMediaProcessingAttempts.assetId, claimed.assetId))
      .orderBy(desc(publicMediaProcessingAttempts.attemptNumber))
      .limit(1)
      .for("update");
    if (asset.state !== "processing" || latest?.id !== claimed.attemptId || latest.finishedAt !== null) {
      retryable("attempt_fenced");
    }
    if (derivatives.length !== 4) throw new Error("Public media derivative set is incomplete");
    for (const derivative of derivatives) {
      const derivativeId = idFactory();
      if (!UUID.test(derivativeId)) throw new Error("Invalid public media derivative ID");
      await tx.insert(publicMediaDerivatives).values({
        id: derivativeId,
        assetId: claimed.assetId,
        variant: derivative.output.variant,
        format: "webp",
        width: derivative.output.width,
        height: derivative.output.height,
        byteSize: derivative.output.byteSize,
        contentHash: derivative.output.sha256,
        objectKey: derivative.key,
        objectVersionId: derivative.versionId,
        verifiedAt: at,
        createdAt: at,
        updatedAt: at,
      });
    }
    const master = derivatives.find((derivative) => derivative.output.variant === "master");
    if (!master) throw new Error("Public media master derivative is missing");
    await tx
      .update(publicMediaAssets)
      .set({
        state: "ready",
        normalizedMasterObjectKey: master.key,
        normalizedMasterObjectVersionId: master.versionId,
        width: processed.source.width,
        height: processed.source.height,
        failureCode: null,
        readyAt: at,
        updatedAt: at,
      })
      .where(eq(publicMediaAssets.id, claimed.assetId));
    await tx
      .update(publicMediaProcessingAttempts)
      .set({ outcomeCode: "succeeded", finishedAt: at, nextRetryAt: null, updatedAt: at })
      .where(eq(publicMediaProcessingAttempts.id, claimed.attemptId));
    await insertOutboxEvent(tx, {
      eventType: "media.public_asset_ready.v1",
      eventVersion: 1,
      aggregateType: "public_media_asset",
      aggregateId: claimed.assetId,
      payload: { assetId: claimed.assetId },
      occurredAt: at,
    });
    return { assetId: claimed.assetId, state: "ready" };
  });
}

function imageFailureCode(error: PublicImageProcessingError): TerminalFailureCode {
  return error.code;
}

function storageError(error: MediaPolicyError): PublicMediaWorkerRetryableError {
  return new PublicMediaWorkerRetryableError(
    error.code === "STORAGE_UNAVAILABLE" || error.code === "MEDIA_NOT_FOUND"
      ? "storage_unavailable"
      : "storage_error",
  );
}

export async function processPublicMediaAsset(
  db: PawketDatabase,
  storage: ObjectStoragePort,
  assetId: string,
  options: ProcessPublicMediaAssetOptions = {},
): Promise<ProcessPublicMediaAssetResult> {
  const { workerId } = validateInput(assetId, options);
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  const processImage = options.processImage ?? processPublicImage;
  const claimed = await claimAsset(db, assetId, workerId, now(), idFactory);
  if (claimed.kind === "settled") return claimed.result;
  let simulatedHardDeath: unknown;
  const checkpoint = async (stage: MediaProcessingCheckpoint): Promise<void> => {
    try {
      await options.checkpoint?.(stage);
    } catch (error) {
      simulatedHardDeath = error;
      throw error;
    }
  };
  try {
    await checkpoint("after_claim");
    const sourceLocation = {
      area: "quarantine" as const,
      key: claimed.sourceKey,
      versionId: claimed.sourceVersionId,
    };
    const sourceHead = await storage.headObject(sourceLocation);
    if (!sourceHead) retryable("storage_unavailable");
    if (!exactPinnedSource(sourceHead, claimed)) {
      throw new PublicMediaWorkerTerminalError("failed_validation");
    }
    const sourceStream = await storage.getObject(sourceLocation);
    const sourceBytes = await boundedBytes(sourceStream, claimed.actualSourceBytes);
    const processed = await processImage(sourceBytes);
    if (processed.source.format !== claimed.declaredSourceFormat) {
      throw new PublicMediaWorkerTerminalError("failed_validation");
    }
    const derivatives: StoredDerivative[] = [];
    for (const output of processed.outputs) {
      derivatives.push(await ensureDerivativeVersion(storage, claimed.assetId, output));
      if (output.variant === "master") await checkpoint("after_master_put");
    }
    await checkpoint("after_derivatives_put");
    await checkpoint("before_ready_commit");
    return await finalizeReady(db, claimed, processed, derivatives, now(), idFactory);
  } catch (error) {
    if (error === simulatedHardDeath) throw error;
    if (error instanceof PublicImageProcessingError) {
      const code = imageFailureCode(error);
      return finalizeFailure(db, claimed, code, code, now());
    }
    if (error instanceof PublicMediaWorkerTerminalError) {
      return finalizeFailure(db, claimed, error.code, error.code, now());
    }
    if (error instanceof MediaPolicyError) {
      return (await recordRetryableFailure(db, claimed, storageError(error), "storage_error", now()))!;
    }
    if (error instanceof PublicMediaWorkerRetryableError) {
      return (await recordRetryableFailure(db, claimed, error, "storage_error", now()))!;
    }
    return (await recordRetryableFailure(db, claimed, error, "processing_error", now()))!;
  }
}
