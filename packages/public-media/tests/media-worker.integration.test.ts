import { randomUUID } from "node:crypto";
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

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = new URL("../../database/migrations/", import.meta.url);
const initialAt = new Date("2026-08-30T08:00:00.000Z");

async function migrate(database: PawketDatabase, filename: string): Promise<void> {
  const migration = await readFile(new URL(filename, migrationsDirectory), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await database.execute(sql.raw(statement));
  }
}

async function createSchemaDatabase(
  schemaName: string,
): Promise<{ db: PawketDatabase; close: () => Promise<void> }> {
  const root = createDatabase(databaseUrl!);
  try {
    await root.db.execute(sql.raw(`create schema "${schemaName}"`));
  } finally {
    await root.close();
  }
  return createDatabase(`${databaseUrl!}?options=-csearch_path%3D${schemaName},public`);
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
    if (location.area === "quarantine" && this.sourceHeadFailure) {
      throw new MediaPolicyError("STORAGE_UNAVAILABLE");
    }
    const versions = this.versions.get(this.mapKey(location.area, location.key)) ?? [];
    const value = location.versionId
      ? versions.find((candidate) => candidate.versionId === location.versionId)
      : versions.at(-1);
    return value
      ? {
          contentLength: value.bytes.byteLength,
          contentType: value.contentType,
          etag: value.etag,
          versionId: value.versionId,
          sha256: value.sha256,
        }
      : null;
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
  }): Promise<void> {
    this.puts.push(input.key);
    this.seed(input, {
      bytes: input.body,
      contentType: input.contentType,
      etag: `etag-${this.puts.length}`,
      sha256: input.sha256,
    });
  }

  async deleteObject(): Promise<void> {
    throw new Error("not used by media worker");
  }
}

describe.skipIf(!databaseUrl)("crash-safe public media worker", () => {
  const schemaName = `public_media_worker_${process.pid}_${Date.now()}`;
  let connection: { db: PawketDatabase; close: () => Promise<void> };
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
        workerId: "stable-media-job",
        now: () => new Date(initialAt.getTime() + 1_000),
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
  });

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
