import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { readdir, readFile } from "node:fs/promises";

import {
  createDatabase,
  identityUsers,
  publicMediaAssets,
  publicMediaDerivatives,
  publicMediaProcessingAttempts,
  publicMediaUploadIntents,
  systemOutbox,
  type PawketDatabase,
} from "@pawket/database";
import { and, eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { MediaPolicyError } from "../src/media-policy.js";
import { processPublicImage } from "../src/image-processor.js";
import {
  processPublicMediaAsset,
  type MediaProcessingCheckpoint,
} from "../src/media-worker.js";
import type {
  HeadObjectResult,
  ObjectLocation,
  ObjectStoragePort,
} from "../src/object-storage-port.js";
import { ObjectStorageConflictError } from "../src/object-storage-port.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const valkeyUrl = process.env.TEST_VALKEY_URL;
const migrationsDirectory = new URL("../../database/migrations/", import.meta.url);
const initialAt = new Date("2026-08-30T08:00:00.000Z");

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function migrate(database: PawketDatabase, filename: string): Promise<void> {
  const migration = await readFile(new URL(filename, migrationsDirectory), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await database.execute(sql.raw(statement));
  }
}

async function createSchemaDatabase(
  schemaName: string,
): Promise<{ db: PawketDatabase; close: () => Promise<void>; url: string }> {
  const root = createDatabase(databaseUrl!);
  try {
    await root.db.execute(sql.raw(`create schema "${schemaName}"`));
  } finally {
    await root.close();
  }
  const url = `${databaseUrl!}?options=-csearch_path%3D${schemaName},public`;
  return { ...createDatabase(url), url };
}

type StoredVersion = {
  versionId: string;
  bytes: Uint8Array;
  contentType: string;
  etag: string;
  sha256: string | null;
};

class VersionedMemoryStorage implements ObjectStoragePort {
  readonly versions = new Map<string, StoredVersion[]>();
  readonly reads: ObjectLocation[] = [];
  readonly puts: string[] = [];
  sourceHeadFailure = false;
  readonly sourceHeadBehaviors: Array<"mismatch" | "retryable_error"> = [];
  genericSourceHeadError: Error | null = null;
  createOnlyRace: ((input: {
    area: "derivative";
    key: string;
    contentType: "image/webp";
    body: Uint8Array;
    sha256: string;
  }) => void) | null = null;

  private mapKey(area: ObjectLocation["area"], key: string): string {
    return `${area}:${key}`;
  }

  seed(location: ObjectLocation, value: Omit<StoredVersion, "versionId"> & { versionId?: string }): string {
    const mapKey = this.mapKey(location.area, location.key);
    const stored = {
      ...value,
      versionId: value.versionId ?? `version-${randomUUID()}`,
      bytes: Uint8Array.from(value.bytes),
    };
    const versions = this.versions.get(mapKey) ?? [];
    versions.push(stored);
    this.versions.set(mapKey, versions);
    return stored.versionId;
  }

  async presignPut(): Promise<never> {
    throw new Error("not used by media worker");
  }

  async headObject(location: ObjectLocation): Promise<HeadObjectResult | null> {
    if (location.area === "quarantine" && this.genericSourceHeadError) {
      throw this.genericSourceHeadError;
    }
    const sourceBehavior =
      location.area === "quarantine" ? this.sourceHeadBehaviors.shift() : undefined;
    if (sourceBehavior === "retryable_error") {
      throw new MediaPolicyError("STORAGE_UNAVAILABLE");
    }
    if (location.area === "quarantine" && this.sourceHeadFailure) {
      throw new MediaPolicyError("STORAGE_UNAVAILABLE");
    }
    const versions = this.versions.get(this.mapKey(location.area, location.key)) ?? [];
    const value = location.versionId
      ? versions.find((candidate) => candidate.versionId === location.versionId)
      : versions.at(-1);
    const result = value
      ? {
          contentLength: value.bytes.byteLength,
          contentType: value.contentType,
          etag: value.etag,
          versionId: value.versionId,
          sha256: value.sha256,
        }
      : null;
    return result && sourceBehavior === "mismatch" ? { ...result, etag: "etag-stale-mismatch" } : result;
  }

  async listObjectVersions(location: Omit<ObjectLocation, "versionId">) {
    return (this.versions.get(this.mapKey(location.area, location.key)) ?? []).map((value) => ({
      versionId: value.versionId,
      isDeleteMarker: false,
    }));
  }

  async getObject(location: ObjectLocation): Promise<NodeJS.ReadableStream> {
    this.reads.push({ ...location });
    const versions = this.versions.get(this.mapKey(location.area, location.key)) ?? [];
    const value = location.versionId
      ? versions.find((candidate) => candidate.versionId === location.versionId)
      : versions.at(-1);
    if (!value) throw new MediaPolicyError("MEDIA_NOT_FOUND");
    return Readable.from([Buffer.from(value.bytes)]);
  }

  async putObject(input: ObjectLocation & {
    area: "derivative";
    contentType: "image/webp";
    body: Uint8Array;
    sha256: string;
    createOnly?: true;
  }): Promise<{ versionId: string }> {
    if (input.createOnly) {
      const race = this.createOnlyRace;
      this.createOnlyRace = null;
      race?.(input);
      const existing = this.versions.get(this.mapKey(input.area, input.key))?.at(-1);
      if (existing) throw new ObjectStorageConflictError();
    }
    this.puts.push(input.key);
    const versionId = this.seed(input, {
      bytes: input.body,
      contentType: input.contentType,
      etag: `etag-${this.puts.length}`,
      sha256: input.sha256,
    });
    return { versionId };
  }

  async deleteObject(): Promise<void> {
    throw new Error("not used by media worker");
  }
}

describe.skipIf(!databaseUrl)("crash-safe public media worker", () => {
  const schemaName = `public_media_worker_${process.pid}_${Date.now()}`;
  let connection: { db: PawketDatabase; close: () => Promise<void>; url: string };
  let sourceBytes: Uint8Array;

  beforeAll(async () => {
    connection = await createSchemaDatabase(schemaName);
    for (const file of (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort()) {
      await migrate(connection.db, file);
    }
    sourceBytes = await sharp({
      create: {
        width: 32,
        height: 24,
        channels: 4,
        background: { r: 30, g: 160, b: 90, alpha: 0.75 },
      },
    })
      .png()
      .toBuffer();
  });

  beforeEach(async () => {
    await connection.db.execute(sql.raw(
      "truncate table public_media_processing_attempts, public_media_derivatives, system_outbox, public_media_upload_intents, public_media_assets, identity_users cascade",
    ));
  });

  afterAll(async () => {
    await connection?.close();
    const cleanup = createDatabase(databaseUrl!);
    try {
      await cleanup.db.execute(sql.raw(`drop schema if exists "${schemaName}" cascade`));
    } finally {
      await cleanup.close();
    }
  });

  async function seedPendingAsset(storage: VersionedMemoryStorage) {
    const assetId = randomUUID();
    const intentId = randomUUID();
    const ownerUserId = `media-worker-${randomUUID()}`;
    const sourceObjectKey = `quarantine/${assetId}/${intentId}`;
    const sourceObjectVersionId = storage.seed(
      { area: "quarantine", key: sourceObjectKey },
      {
        versionId: `source-${randomUUID()}`,
        bytes: sourceBytes,
        contentType: "image/png",
        etag: `etag-source-${randomUUID()}`,
        sha256: null,
      },
    );
    const source = await storage.headObject({
      area: "quarantine",
      key: sourceObjectKey,
      versionId: sourceObjectVersionId,
    });
    if (!source?.etag) throw new Error("test source was not created");
    const db = connection.db;
    await db.insert(identityUsers).values({
      id: ownerUserId,
      name: "Media worker creator",
      email: `${ownerUserId}@example.test`,
      canonicalEmail: `${ownerUserId}@example.test`,
      emailVerified: false,
      createdAt: initialAt,
      updatedAt: initialAt,
    });
    await db.insert(publicMediaAssets).values({
      id: assetId,
      ownerUserId,
      purpose: "showcase",
      declaredSourceFormat: "png",
      state: "awaiting_upload",
      sourceAllocationBytes: sourceBytes.byteLength,
      sourceObjectKey,
      createdAt: initialAt,
      updatedAt: initialAt,
    });
    await db.insert(publicMediaUploadIntents).values({
      id: intentId,
      assetId,
      ownerUserId,
      purpose: "showcase",
      declaredSourceFormat: "png",
      maxSourceBytes: sourceBytes.byteLength,
      maxSourcePixels: 40_000_000,
      objectKey: sourceObjectKey,
      state: "completed",
      expiresAt: new Date(initialAt.getTime() + 15 * 60_000),
      completedAt: initialAt,
      createdAt: initialAt,
      updatedAt: initialAt,
    });
    await db
      .update(publicMediaAssets)
      .set({
        state: "pending",
        sourceObjectVersionId,
        sourceObjectEtag: source.etag,
        actualSourceBytes: sourceBytes.byteLength,
        updatedAt: initialAt,
      })
      .where(eq(publicMediaAssets.id, assetId));
    return { assetId, sourceObjectKey, sourceObjectVersionId };
  }

  test("reads only the pinned source version and commits one exact ready asset", async () => {
    const storage = new VersionedMemoryStorage();
    const fixture = await seedPendingAsset(storage);
    storage.seed(
      { area: "quarantine", key: fixture.sourceObjectKey },
      {
        versionId: `later-${randomUUID()}`,
        bytes: await sharp(sourceBytes).negate().png().toBuffer(),
        contentType: "image/png",
        etag: `etag-later-${randomUUID()}`,
        sha256: null,
      },
    );

    await expect(
      processPublicMediaAsset(connection.db, storage, fixture.assetId, {
        workerId: "media-worker-one",
        now: () => initialAt,
      }),
    ).resolves.toMatchObject({ state: "ready", assetId: fixture.assetId });

    expect(storage.reads).toEqual([
      {
        area: "quarantine",
        key: fixture.sourceObjectKey,
        versionId: fixture.sourceObjectVersionId,
      },
    ]);
    const [asset] = await connection.db
      .select()
      .from(publicMediaAssets)
      .where(eq(publicMediaAssets.id, fixture.assetId));
    expect(asset).toMatchObject({ state: "ready", width: 32, height: 24, failureCode: null });
    const derivatives = await connection.db
      .select()
      .from(publicMediaDerivatives)
      .where(eq(publicMediaDerivatives.assetId, fixture.assetId));
    expect(derivatives.map((row) => row.variant).sort()).toEqual([
      "display",
      "large",
      "master",
      "thumb",
    ]);
    expect(derivatives.every((row) => row.objectVersionId.startsWith("version-"))).toBe(true);
    const attempts = await connection.db
      .select()
      .from(publicMediaProcessingAttempts)
      .where(eq(publicMediaProcessingAttempts.assetId, fixture.assetId));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ attemptNumber: 1, outcomeCode: "succeeded" });
    const readyEvents = await connection.db
      .select()
      .from(systemOutbox)
      .where(
        and(
          eq(systemOutbox.aggregateId, fixture.assetId),
          eq(systemOutbox.eventType, "media.public_asset_ready.v1"),
        ),
      );
    expect(readyEvents).toHaveLength(1);
    expect(readyEvents[0]?.payload).toEqual({ assetId: fixture.assetId });
    expect(JSON.stringify(readyEvents[0]?.payload)).not.toMatch(
      /object|version|filename|signed|source|bytes/iu,
    );
  });

  test.each([
    "after_claim",
    "after_master_put",
    "after_derivatives_put",
    "before_ready_commit",
  ] as const)("retry after crash window %s converges on one logical asset", async (crashAt) => {
    const storage = new VersionedMemoryStorage();
    const fixture = await seedPendingAsset(storage);
    let crashed = false;
    const checkpoint = async (stage: MediaProcessingCheckpoint) => {
      if (!crashed && stage === crashAt) {
        crashed = true;
        throw new Error(`simulated-crash:${stage}`);
      }
    };

    await expect(
      processPublicMediaAsset(connection.db, storage, fixture.assetId, {
        workerId: "stable-media-job",
        now: () => initialAt,
        checkpoint,
      }),
    ).rejects.toThrow(`simulated-crash:${crashAt}`);
    await expect(
      processPublicMediaAsset(connection.db, storage, fixture.assetId, {
        workerId: "replacement-media-worker",
        now: () => new Date(initialAt.getTime() + 10 * 60_000 + 1),
      }),
    ).resolves.toMatchObject({ state: "ready" });

    expect(
      await connection.db
        .select()
        .from(publicMediaDerivatives)
        .where(eq(publicMediaDerivatives.assetId, fixture.assetId)),
    ).toHaveLength(4);
    expect(storage.puts).toHaveLength(4);
    const readyEvents = await connection.db
      .select()
      .from(systemOutbox)
      .where(
        and(
          eq(systemOutbox.aggregateId, fixture.assetId),
          eq(systemOutbox.eventType, "media.public_asset_ready.v1"),
        ),
      );
    expect(readyEvents).toHaveLength(1);
    const attempts = await connection.db
      .select()
      .from(publicMediaProcessingAttempts)
      .where(eq(publicMediaProcessingAttempts.assetId, fixture.assetId));
    expect(attempts).toHaveLength(2);
    expect(attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attemptNumber: 1, outcomeCode: "retryable" }),
        expect.objectContaining({ attemptNumber: 2, outcomeCode: "succeeded" }),
      ]),
    );
  });

  test("an active lease blocks duplicate delivery even when the worker identity matches", async () => {
    const storage = new VersionedMemoryStorage();
    const fixture = await seedPendingAsset(storage);
    const claimed = deferred();
    const release = deferred();
    const first = processPublicMediaAsset(connection.db, storage, fixture.assetId, {
      workerId: "runtime-media-worker-one",
      now: () => initialAt,
      checkpoint: async (stage) => {
        if (stage === "after_claim") {
          claimed.resolve();
          await release.promise;
        }
      },
    });
    await claimed.promise;

    await expect(
      processPublicMediaAsset(connection.db, storage, fixture.assetId, {
        workerId: "runtime-media-worker-one",
        now: () => new Date(initialAt.getTime() + 1_000),
      }),
    ).rejects.toMatchObject({
      code: "processing_lease_active",
      retryAt: new Date(initialAt.getTime() + 10 * 60_000),
    });

    release.resolve();
    await expect(first).resolves.toMatchObject({ state: "ready" });
    const attempts = await connection.db
      .select()
      .from(publicMediaProcessingAttempts)
      .where(eq(publicMediaProcessingAttempts.assetId, fixture.assetId));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ outcomeCode: "succeeded" });
  });

  test.skipIf(!valkeyUrl)(
    "BullMQ defers repeated early delivery until an expired hard-death lease can be taken over",
    async () => {
      const queueModulePath = "../../queue/src/index.js";
      const runtimeModulePath = "../../../apps/worker/src/worker-runtime.js";
      const { createMediaQueue, createQueueConnection, MEDIA_PROCESS_JOB } = await import(
        queueModulePath
      );
      const { startWorker } = await import(runtimeModulePath);
      const isolatedUrl = new URL(valkeyUrl!);
      isolatedUrl.pathname = "/14";
      const runtimeValkeyUrl = isolatedUrl.toString();
      const inspectionConnection = createQueueConnection(runtimeValkeyUrl);
      const queue = createMediaQueue(inspectionConnection);
      const handles: Array<{ stop(): Promise<void> }> = [];
      const logger = { info() {}, error() {} };

      const waitForJobState = async (
        state: "completed" | "delayed",
        minimumAttemptsStarted: number,
        timeoutMs = 10_000,
      ) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const job = await queue.getJob(fixture.assetId);
          if (
            job &&
            (await job.getState()) === state &&
            job.attemptsStarted >= minimumAttemptsStarted
          ) {
            return job;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const job = await queue.getJob(fixture.assetId);
        throw new Error(
          `Timed out waiting for ${state}; actual=${job ? await job.getState() : "missing"}; ` +
            `attemptsMade=${job?.attemptsMade ?? "missing"}; ` +
            `attemptsStarted=${job?.attemptsStarted ?? "missing"}`,
        );
      };

      const storage = new VersionedMemoryStorage();
      const fixture = await seedPendingAsset(storage);
      const leaseExpiresAtMs = Date.now() + 5_000;
      const crashedClaimAt = new Date(leaseExpiresAtMs - 10 * 60_000);

      try {
        await queue.waitUntilReady();
        await queue.obliterate({ force: true });

        await expect(
          processPublicMediaAsset(connection.db, storage, fixture.assetId, {
            workerId: "hard-death-runtime",
            now: () => crashedClaimAt,
            checkpoint: async (stage) => {
              if (stage === "after_claim") throw new Error("simulated-hard-death");
            },
          }),
        ).rejects.toThrow("simulated-hard-death");

        const earlyHandle = await startWorker({
          databaseUrl: connection.url,
          valkeyUrl: runtimeValkeyUrl,
          concurrency: 1,
          batchSize: 10,
          leaseMs: 30_000,
          signalSource: new EventEmitter(),
          logger,
          publicMedia: { storage, concurrency: 1 },
          dependencies: {
            hostname: () => "early-runtime",
            randomUUID: () => "00000000-0000-4000-8000-000000000001",
          },
        });
        handles.push(earlyHandle);

        await queue.add(
          MEDIA_PROCESS_JOB,
          { assetId: fixture.assetId },
          {
            attempts: 8,
            backoff: { type: "exponential", delay: 1_000 },
            removeOnComplete: false,
            removeOnFail: false,
          },
        );
        const firstDelay = await waitForJobState("delayed", 1);
        expect(firstDelay.attemptsMade).toBe(0);

        await firstDelay.promote();
        const secondDelay = await waitForJobState("delayed", 2);
        expect(secondDelay.attemptsMade).toBe(0);
        const attemptsBeforeExpiry = await connection.db
          .select()
          .from(publicMediaProcessingAttempts)
          .where(eq(publicMediaProcessingAttempts.assetId, fixture.assetId));
        expect(attemptsBeforeExpiry).toHaveLength(1);
        expect(attemptsBeforeExpiry[0]).toMatchObject({
          attemptNumber: 1,
          workerId: "hard-death-runtime",
          finishedAt: null,
          outcomeCode: "started",
        });

        await earlyHandle.stop();
        handles.splice(handles.indexOf(earlyHandle), 1);
        const waitUntilExpiryMs = Math.max(0, leaseExpiresAtMs - Date.now() + 50);
        await new Promise((resolve) => setTimeout(resolve, waitUntilExpiryMs));

        const takeoverHandle = await startWorker({
          databaseUrl: connection.url,
          valkeyUrl: runtimeValkeyUrl,
          concurrency: 1,
          batchSize: 10,
          leaseMs: 30_000,
          signalSource: new EventEmitter(),
          logger,
          publicMedia: { storage, concurrency: 1 },
          dependencies: {
            hostname: () => "takeover-runtime",
            randomUUID: () => "00000000-0000-4000-8000-000000000002",
          },
        });
        handles.push(takeoverHandle);

        await waitForJobState("completed", 3);
        await expect.poll(
          async () => (await queue.getJob(fixture.assetId))?.attemptsMade,
          { timeout: 2_000 },
        ).toBe(1);
        const completedJob = await queue.getJob(fixture.assetId);
        expect(completedJob).not.toBeUndefined();
        expect(completedJob?.attemptsStarted).toBe(3);

        const attempts = await connection.db
          .select()
          .from(publicMediaProcessingAttempts)
          .where(eq(publicMediaProcessingAttempts.assetId, fixture.assetId));
        expect(attempts).toHaveLength(2);
        expect(attempts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              attemptNumber: 1,
              workerId: "hard-death-runtime",
              outcomeCode: "retryable",
            }),
            expect.objectContaining({
              attemptNumber: 2,
              workerId: "takeover-runtime:00000000-0000-4000-8000-000000000002",
              outcomeCode: "succeeded",
            }),
          ]),
        );
        expect(attempts.every((attempt) => attempt.finishedAt !== null)).toBe(true);

        const [asset] = await connection.db
          .select()
          .from(publicMediaAssets)
          .where(eq(publicMediaAssets.id, fixture.assetId));
        expect(asset).toMatchObject({ state: "ready", failureCode: null });
        const events = await connection.db
          .select()
          .from(systemOutbox)
          .where(eq(systemOutbox.aggregateId, fixture.assetId));
        expect(events.filter((event) => event.eventType === "media.public_asset_ready.v1")).toHaveLength(1);
        expect(events.filter((event) => event.eventType === "media.public_asset_failed.v1")).toHaveLength(0);
        expect(storage.puts).toHaveLength(4);
      } finally {
        await Promise.all(handles.splice(0).map((handle) => handle.stop()));
        await queue.obliterate({ force: true }).catch(() => undefined);
        await queue.close().catch(() => undefined);
        if (inspectionConnection.status !== "end") {
          await inspectionConnection.quit().catch(() => inspectionConnection.disconnect());
        }
      }
    },
    20_000,
  );

  test("a stale claimant cannot publish ready or leave the takeover attempt unfinished", async () => {
    const storage = new VersionedMemoryStorage();
    const fixture = await seedPendingAsset(storage);
    const firstClaimed = deferred();
    const releaseFirst = deferred();
    const secondClaimed = deferred();
    const releaseSecond = deferred();
    const first = processPublicMediaAsset(connection.db, storage, fixture.assetId, {
      workerId: "stale-media-worker",
      now: () => initialAt,
      checkpoint: async (stage) => {
        if (stage === "after_claim") {
          firstClaimed.resolve();
          await releaseFirst.promise;
        }
      },
    });
    await firstClaimed.promise;
    const second = processPublicMediaAsset(connection.db, storage, fixture.assetId, {
      workerId: "takeover-media-worker",
      now: () => new Date(initialAt.getTime() + 10 * 60_000 + 1),
      checkpoint: async (stage) => {
        if (stage === "after_claim") {
          secondClaimed.resolve();
          await releaseSecond.promise;
        }
      },
    });
    await secondClaimed.promise;

    releaseFirst.resolve();
    const staleOutcome = await first.then(
      (value) => ({ kind: "resolved" as const, value }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    const [duringTakeover] = await connection.db
      .select({ state: publicMediaAssets.state })
      .from(publicMediaAssets)
      .where(eq(publicMediaAssets.id, fixture.assetId));
    releaseSecond.resolve();
    const takeoverOutcome = await second;

    expect(staleOutcome).toMatchObject({
      kind: "rejected",
      error: { code: "attempt_fenced" },
    });
    expect(duringTakeover).toEqual({ state: "processing" });
    expect(takeoverOutcome).toMatchObject({ state: "ready" });
    const attempts = await connection.db
      .select()
      .from(publicMediaProcessingAttempts)
      .where(eq(publicMediaProcessingAttempts.assetId, fixture.assetId));
    expect(attempts).toHaveLength(2);
    expect(attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attemptNumber: 1, outcomeCode: "retryable" }),
        expect.objectContaining({ attemptNumber: 2, outcomeCode: "succeeded" }),
      ]),
    );
  });

  test.each(["mismatch", "retryable_error"] as const)(
    "a stale claimant cannot move a takeover attempt to failed or pending after %s",
    async (sourceBehavior) => {
      const storage = new VersionedMemoryStorage();
      const fixture = await seedPendingAsset(storage);
      const firstClaimed = deferred();
      const releaseFirst = deferred();
      const secondClaimed = deferred();
      const releaseSecond = deferred();
      const first = processPublicMediaAsset(connection.db, storage, fixture.assetId, {
        workerId: "stale-media-worker",
        now: () => initialAt,
        checkpoint: async (stage) => {
          if (stage === "after_claim") {
            firstClaimed.resolve();
            await releaseFirst.promise;
          }
        },
      });
      await firstClaimed.promise;
      storage.sourceHeadBehaviors.push(sourceBehavior);
      const second = processPublicMediaAsset(connection.db, storage, fixture.assetId, {
        workerId: "takeover-media-worker",
        now: () => new Date(initialAt.getTime() + 10 * 60_000 + 1),
        checkpoint: async (stage) => {
          if (stage === "after_claim") {
            secondClaimed.resolve();
            await releaseSecond.promise;
          }
        },
      });
      await secondClaimed.promise;

      releaseFirst.resolve();
      const staleOutcome = await first.then(
        (value) => ({ kind: "resolved" as const, value }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      );
      const [duringTakeover] = await connection.db
        .select({ state: publicMediaAssets.state })
        .from(publicMediaAssets)
        .where(eq(publicMediaAssets.id, fixture.assetId));
      releaseSecond.resolve();
      const takeoverOutcome = await second.then(
        (value) => ({ kind: "resolved" as const, value }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      );

      expect(staleOutcome).toMatchObject({
        kind: "rejected",
        error: { code: "attempt_fenced" },
      });
      expect(duringTakeover).toEqual({ state: "processing" });
      expect(takeoverOutcome).toMatchObject({ kind: "resolved", value: { state: "ready" } });
      const attempts = await connection.db
        .select()
        .from(publicMediaProcessingAttempts)
        .where(eq(publicMediaProcessingAttempts.assetId, fixture.assetId));
      expect(attempts).toHaveLength(2);
      expect(attempts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ attemptNumber: 1, outcomeCode: "retryable" }),
          expect.objectContaining({ attemptNumber: 2, outcomeCode: "succeeded" }),
        ]),
      );
    },
  );

  test("a conflicting deterministic derivative key fails terminally without overwrite", async () => {
    const storage = new VersionedMemoryStorage();
    const fixture = await seedPendingAsset(storage);
    const processed = await processPublicImage(sourceBytes);
    const master = processed.outputs.find((output) => output.variant === "master");
    if (!master) throw new Error("master output missing");
    const key = `derivatives/${fixture.assetId}/master/${master.sha256.slice("sha256:v1:".length)}.webp`;
    storage.seed(
      { area: "derivative", key },
      {
        bytes: Buffer.from("wrong"),
        contentType: "image/webp",
        etag: "etag-conflict",
        sha256: `sha256:v1:${"A".repeat(43)}`,
      },
    );

    await expect(
      processPublicMediaAsset(connection.db, storage, fixture.assetId, {
        workerId: "media-conflict-worker",
        now: () => initialAt,
      }),
    ).resolves.toMatchObject({ state: "failed", failureCode: "derivative_key_conflict" });

    expect(storage.puts).toHaveLength(0);
    expect(
      (
        await connection.db
          .select()
          .from(publicMediaAssets)
          .where(eq(publicMediaAssets.id, fixture.assetId))
      )[0],
    ).toMatchObject({ state: "failed", failureCode: "derivative_key_conflict" });
  });

  test("a create-only race reuses an exact winner without creating a second version", async () => {
    const storage = new VersionedMemoryStorage();
    const fixture = await seedPendingAsset(storage);
    let racedKey: string | undefined;
    storage.createOnlyRace = (input) => {
      racedKey = input.key;
      storage.seed(input, {
        bytes: input.body,
        contentType: input.contentType,
        etag: "etag-race-winner",
        sha256: input.sha256,
      });
    };

    await expect(
      processPublicMediaAsset(connection.db, storage, fixture.assetId, {
        workerId: "media-exact-race-worker",
        now: () => initialAt,
      }),
    ).resolves.toMatchObject({ state: "ready" });

    expect(racedKey).toBeDefined();
    expect(storage.versions.get(`derivative:${racedKey}`)).toHaveLength(1);
    expect(storage.puts).toHaveLength(3);
  });

  test("a create-only race with different bytes fails without overwriting the winner", async () => {
    const storage = new VersionedMemoryStorage();
    const fixture = await seedPendingAsset(storage);
    let racedKey: string | undefined;
    storage.createOnlyRace = (input) => {
      racedKey = input.key;
      storage.seed(input, {
        bytes: Buffer.from("race-winner-different-bytes"),
        contentType: input.contentType,
        etag: "etag-race-conflict",
        sha256: `sha256:v1:${"A".repeat(43)}`,
      });
    };

    await expect(
      processPublicMediaAsset(connection.db, storage, fixture.assetId, {
        workerId: "media-conflicting-race-worker",
        now: () => initialAt,
      }),
    ).resolves.toMatchObject({ state: "failed", failureCode: "derivative_key_conflict" });

    expect(racedKey).toBeDefined();
    const versions = storage.versions.get(`derivative:${racedKey}`);
    expect(versions).toHaveLength(1);
    expect(Buffer.from(versions?.[0]?.bytes ?? [])).toEqual(
      Buffer.from("race-winner-different-bytes"),
    );
    expect(storage.puts).toHaveLength(0);
  });

  test("storage failures remain retryable until attempt eight", async () => {
    const storage = new VersionedMemoryStorage();
    const fixture = await seedPendingAsset(storage);
    storage.sourceHeadFailure = true;

    for (let attempt = 1; attempt < 8; attempt += 1) {
      await expect(
        processPublicMediaAsset(connection.db, storage, fixture.assetId, {
          workerId: "media-retry-worker",
          now: () => new Date(initialAt.getTime() + attempt * 1_000),
        }),
      ).rejects.toMatchObject({ code: "storage_unavailable" });
      expect(
        (
          await connection.db
            .select()
            .from(publicMediaAssets)
            .where(eq(publicMediaAssets.id, fixture.assetId))
        )[0]?.state,
      ).toBe("pending");
    }

    await expect(
      processPublicMediaAsset(connection.db, storage, fixture.assetId, {
        workerId: "media-retry-worker",
        now: () => new Date(initialAt.getTime() + 8_000),
      }),
    ).resolves.toMatchObject({ state: "failed", failureCode: "storage_error" });
    expect(
      await connection.db
        .select()
        .from(publicMediaProcessingAttempts)
        .where(eq(publicMediaProcessingAttempts.assetId, fixture.assetId)),
    ).toHaveLength(8);
    const failedEvents = await connection.db
      .select()
      .from(systemOutbox)
      .where(
        and(
          eq(systemOutbox.aggregateId, fixture.assetId),
          eq(systemOutbox.eventType, "media.public_asset_failed.v1"),
        ),
      );
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]?.payload).toEqual({
      assetId: fixture.assetId,
      failureCode: "storage_error",
    });
  });

  test.each(["processor", "storage"] as const)(
    "a caught generic %s failure closes every attempt and terminalizes on call eight",
    async (failureStage) => {
      const storage = new VersionedMemoryStorage();
      const fixture = await seedPendingAsset(storage);
      const primaryError = new Error(`primary-${failureStage}-failure`);
      if (failureStage === "storage") storage.genericSourceHeadError = primaryError;
      const processImage = async (): Promise<never> => {
        throw primaryError;
      };

      for (let attempt = 1; attempt < 8; attempt += 1) {
        await expect(
          processPublicMediaAsset(connection.db, storage, fixture.assetId, {
            workerId: `generic-${failureStage}-worker`,
            now: () => new Date(initialAt.getTime() + attempt * 1_000),
            ...(failureStage === "processor" ? { processImage } : {}),
          }),
        ).rejects.toBe(primaryError);
      }
      await expect(
        processPublicMediaAsset(connection.db, storage, fixture.assetId, {
          workerId: `generic-${failureStage}-worker`,
          now: () => new Date(initialAt.getTime() + 8_000),
          ...(failureStage === "processor" ? { processImage } : {}),
        }),
      ).resolves.toMatchObject({ state: "failed", failureCode: "processing_error" });

      const attempts = await connection.db
        .select()
        .from(publicMediaProcessingAttempts)
        .where(eq(publicMediaProcessingAttempts.assetId, fixture.assetId));
      expect(attempts).toHaveLength(8);
      expect(attempts.every((attempt) => attempt.finishedAt !== null)).toBe(true);
      expect(attempts.at(-1)).toMatchObject({
        attemptNumber: 8,
        outcomeCode: "processing_error",
      });
      const failedEvents = await connection.db
        .select()
        .from(systemOutbox)
        .where(
          and(
            eq(systemOutbox.aggregateId, fixture.assetId),
            eq(systemOutbox.eventType, "media.public_asset_failed.v1"),
          ),
        );
      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0]?.payload).toEqual({
        assetId: fixture.assetId,
        failureCode: "processing_error",
      });
    },
  );

  test("a ready replay is side-effect free", async () => {
    const storage = new VersionedMemoryStorage();
    const fixture = await seedPendingAsset(storage);
    await processPublicMediaAsset(connection.db, storage, fixture.assetId, {
      workerId: "media-replay-worker",
      now: () => initialAt,
    });
    const puts = [...storage.puts];

    await expect(
      processPublicMediaAsset(connection.db, storage, fixture.assetId, {
        workerId: "media-replay-worker",
        now: () => new Date(initialAt.getTime() + 2_000),
      }),
    ).resolves.toMatchObject({ state: "ready" });

    expect(storage.puts).toEqual(puts);
    expect(
      await connection.db
        .select()
        .from(publicMediaProcessingAttempts)
        .where(eq(publicMediaProcessingAttempts.assetId, fixture.assetId)),
    ).toHaveLength(1);
  });
});
