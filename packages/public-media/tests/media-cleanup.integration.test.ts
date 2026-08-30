import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import {
  createDatabase,
  creatorPageDrafts,
  creatorPages,
  creatorPublicationEvents,
  creatorPublicationRevisions,
  identityUsers,
  publicMediaAssets,
  publicMediaDerivatives,
  publicMediaUploadIntents,
  type PawketDatabase,
} from "@pawket/database";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import {
  PublicMediaCleanupConfigurationError,
  runPublicMediaCleanup,
  type PublicMediaCleanupRule,
} from "../src/media-cleanup.js";
import type { HeadObjectResult, ObjectLocation, ObjectStoragePort } from "../src/object-storage-port.js";
import { createS3ObjectStorage } from "../src/s3-object-storage.js";
import { deleteEveryS3ObjectVersion, ensureVersionedBuckets } from "./s3-test-helpers.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = new URL("../../database/migrations/", import.meta.url);
const exactAt = new Date("2026-09-01T00:00:00.000Z");
const hour = 60 * 60_000;
const day = 24 * hour;
const s3Endpoint = process.env.PUBLIC_MEDIA_S3_ENDPOINT ?? "http://localhost:9090";
const s3Region = process.env.PUBLIC_MEDIA_S3_REGION ?? "us-east-1";
const s3AccessKeyId = process.env.PUBLIC_MEDIA_S3_ACCESS_KEY_ID ?? "local-media-access-key";
const s3SecretAccessKey = process.env.PUBLIC_MEDIA_S3_SECRET_ACCESS_KEY ?? "local-media-secret-key";
const quarantineBucket = process.env.PUBLIC_MEDIA_QUARANTINE_BUCKET ?? "pawket-media-quarantine";
const derivativeBucket = process.env.PUBLIC_MEDIA_DERIVATIVE_BUCKET ?? "pawket-media-derivatives";

async function migrate(database: PawketDatabase, filename: string): Promise<void> {
  const migration = await readFile(new URL(filename, migrationsDirectory), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await database.execute(sql.raw(statement));
  }
}

class CleanupMemoryStorage implements ObjectStoragePort {
  readonly sourceVersions = new Map<string, Array<{ versionId: string; isDeleteMarker: boolean }>>();
  readonly derivativeVersions = new Map<string, { versionId: string; bytes: number; sha256: string }>();
  readonly deletes: ObjectLocation[] = [];
  failDelete = false;
  failVerify = false;

  seedSource(key: string, versions = [
    { versionId: "source-version-1", isDeleteMarker: false },
    { versionId: "source-delete-marker-1", isDeleteMarker: true },
    { versionId: "source-version-2", isDeleteMarker: false },
  ]): void {
    this.sourceVersions.set(key, versions.map((value) => ({ ...value })));
  }

  seedDerivative(key: string, versionId: string, bytes: number, sha256: string): void {
    this.derivativeVersions.set(key, { versionId, bytes, sha256 });
  }

  async presignPut(): Promise<never> { throw new Error("not used by cleanup"); }
  async getObject(): Promise<never> { throw new Error("not used by cleanup"); }
  async putObject(): Promise<never> { throw new Error("not used by cleanup"); }

  async headObject(location: ObjectLocation): Promise<HeadObjectResult | null> {
    if (this.failVerify) throw new Error("provider-secret-verify");
    if (location.area !== "derivative") return null;
    const stored = this.derivativeVersions.get(location.key);
    if (!stored || stored.versionId !== location.versionId) return null;
    return {
      contentLength: stored.bytes,
      contentType: "image/webp",
      etag: "opaque-etag",
      versionId: stored.versionId,
      sha256: stored.sha256,
    };
  }

  async listObjectVersions(location: Omit<ObjectLocation, "versionId">) {
    if (this.failVerify) throw new Error("provider-secret-list");
    return (this.sourceVersions.get(location.key) ?? []).map((value) => ({ ...value }));
  }

  async deleteObject(location: ObjectLocation): Promise<void> {
    this.deletes.push({ ...location });
    if (this.failDelete) throw new Error("provider-secret-delete");
    if (location.area === "quarantine") {
      const remaining = (this.sourceVersions.get(location.key) ?? []).filter(
        (value) => value.versionId !== location.versionId,
      );
      this.sourceVersions.set(location.key, remaining);
    } else {
      const stored = this.derivativeVersions.get(location.key);
      if (stored?.versionId === location.versionId) this.derivativeVersions.delete(location.key);
    }
  }
}

describe.skipIf(!databaseUrl)("deterministic public media cleanup", () => {
  const schemaName = `public_media_cleanup_${process.pid}_${Date.now()}`;
  let connection: { db: PawketDatabase; close: () => Promise<void> };
  const s3 = new S3Client({
    endpoint: s3Endpoint,
    region: s3Region,
    forcePathStyle: true,
    credentials: { accessKeyId: s3AccessKeyId, secretAccessKey: s3SecretAccessKey },
  });

  beforeAll(async () => {
    const root = createDatabase(databaseUrl!);
    try { await root.db.execute(sql.raw(`create schema "${schemaName}"`)); }
    finally { await root.close(); }
    connection = createDatabase(`${databaseUrl!}?options=-csearch_path%3D${schemaName},public`);
    for (const file of (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort()) {
      await migrate(connection.db, file);
    }
    await ensureVersionedBuckets(s3, [quarantineBucket, derivativeBucket]);
  });

  beforeEach(async () => {
    await connection.db.execute(sql.raw(
      "truncate table public_media_processing_attempts, public_media_derivatives, public_media_upload_intents, public_media_assets, creator_discovery_projections, creator_publication_events, creator_publication_media, creator_publication_showcases, creator_publication_revisions, creator_showcase_draft_media, creator_showcase_drafts, creator_page_drafts, creator_handle_claims, creator_pages, identity_users cascade",
    ));
  });

  afterAll(async () => {
    await connection?.close();
    const root = createDatabase(databaseUrl!);
    try { await root.db.execute(sql.raw(`drop schema if exists "${schemaName}" cascade`)); }
    finally { await root.close(); }
    s3.destroy();
  });

  test.each([
    ["processed_source", 24 * hour],
    ["failed_quarantine", 7 * day],
    ["ready_unreferenced", 30 * day],
    ["superseded_derivative", 180 * day],
  ] as const)("selects %s at its exact age but not one millisecond before", async (rule, age) => {
    const storage = new CleanupMemoryStorage();
    const asset = await seedRuleCandidate(connection.db, storage, rule, new Date(exactAt.getTime() - age));

    const early = await cleanup(connection.db, storage, new Date(exactAt.getTime() - 1));
    expect(early.results.filter((result) => result.assetId === asset.assetId && result.rule === rule)).toEqual([]);
    expect(early.counts[rule]).toEqual({ candidate: 0, protected: 0, processed: 0, failed: 0 });

    const exact = await cleanup(connection.db, storage, exactAt);
    expect(exact.results.filter((result) => result.assetId === asset.assetId && result.rule === rule)).toEqual([
      expect.objectContaining({ rule, assetId: asset.assetId, disposition: "candidate", eligibleAt: exactAt }),
    ]);
    expect(exact.counts[rule]).toEqual({ candidate: 1, protected: 0, processed: 0, failed: 0 });
    expect(storage.deletes).toEqual([]);
  });

  test("uses stable eligibleAt, assetId, objectKeyHash ordering and a bounded batch", async () => {
    const storage = new CleanupMemoryStorage();
    const eligibleAt = new Date(exactAt.getTime() - 7 * day);
    const seeded = await Promise.all([
      seedFailedAsset(connection.db, storage, eligibleAt, "00000000-0000-4000-8000-000000000301"),
      seedFailedAsset(connection.db, storage, eligibleAt, "00000000-0000-4000-8000-000000000201"),
      seedFailedAsset(connection.db, storage, new Date(eligibleAt.getTime() - 1), "00000000-0000-4000-8000-000000000401"),
    ]);
    const result = await cleanup(connection.db, storage, exactAt, { batchSize: 2 });
    const expected = seeded
      .map((value) => ({ ...value, eligibleAt: new Date(value.failedAt.getTime() + 7 * day) }))
      .sort((left, right) => left.eligibleAt.getTime() - right.eligibleAt.getTime() || left.assetId.localeCompare(right.assetId) || left.objectKeyHash.localeCompare(right.objectKeyHash))
      .slice(0, 2)
      .map((value) => value.assetId);
    expect(result.results.map((value) => value.assetId)).toEqual(expected);
    expect(result.results).toHaveLength(2);
  });

  test.each(["report", "incident", "legal"])("a real %s hold protects source and derivatives", async () => {
    const storage = new CleanupMemoryStorage();
    const source = await seedRuleCandidate(connection.db, storage, "processed_source", new Date(exactAt.getTime() - 24 * hour));
    const derivative = await seedRuleCandidate(connection.db, storage, "ready_unreferenced", new Date(exactAt.getTime() - 30 * day));
    const protectedIds = new Set([source.assetId, derivative.assetId]);
    const result = await cleanup(connection.db, storage, exactAt, {
      mode: "enforce",
      retentionMode: "enforce",
      globalPause: false,
      acceptanceReference: "accepted-revision-3844c65",
      holds: { protectedAssetIds: async () => protectedIds },
    });
    expect(result.results.map((value) => value.disposition)).toEqual(["protected", "protected"]);
    expect(result.protectedCount).toBe(2);
    expect(result.processedCount).toBe(0);
    expect(storage.deletes).toEqual([]);
  });

  test("report-only and a global pause never call object storage or mutate cleanup facts", async () => {
    const storage = new CleanupMemoryStorage();
    const candidate = await seedRuleCandidate(connection.db, storage, "processed_source", new Date(exactAt.getTime() - 24 * hour));
    const report = await cleanup(connection.db, storage, exactAt);
    expect(report.results).toEqual([expect.objectContaining({ assetId: candidate.assetId, disposition: "candidate" })]);
    expect(storage.deletes).toEqual([]);
    expect((await connection.db.select().from(publicMediaAssets).where(eq(publicMediaAssets.id, candidate.assetId)))[0]?.sourceDeletedAt).toBeNull();

    const paused = await cleanup(connection.db, storage, exactAt, {
      mode: "enforce",
      retentionMode: "enforce",
      globalPause: true,
      acceptanceReference: "accepted-revision-3844c65",
    });
    expect(paused.results).toEqual([expect.objectContaining({ assetId: candidate.assetId, disposition: "candidate" })]);
    expect(storage.deletes).toEqual([]);
    expect((await connection.db.select().from(publicMediaAssets).where(eq(publicMediaAssets.id, candidate.assetId)))[0]?.sourceDeletedAt).toBeNull();
  });

  test.each([
    [{ mode: "enforce", retentionMode: "report_only", globalPause: false, acceptanceReference: "accepted-revision-3844c65" }, "global retention mode"],
    [{ mode: "enforce", retentionMode: "enforce", globalPause: false, acceptanceReference: undefined }, "acceptance"],
    [{ mode: "enforce", retentionMode: "enforce", globalPause: false, acceptanceReference: " padded " }, "acceptance"],
  ] as const)("rejects enforce when the %s gate is closed", async (gate, _label) => {
    void _label;
    const storage = new CleanupMemoryStorage();
    await seedRuleCandidate(connection.db, storage, "processed_source", new Date(exactAt.getTime() - 24 * hour));
    await expect(cleanup(connection.db, storage, exactAt, gate)).rejects.toBeInstanceOf(PublicMediaCleanupConfigurationError);
    expect(storage.deletes).toEqual([]);
  });

  test("deletes every quarantine version and delete marker, verifies absence, and records only safe source facts", async () => {
    const storage = new CleanupMemoryStorage();
    const candidate = await seedRuleCandidate(connection.db, storage, "processed_source", new Date(exactAt.getTime() - 24 * hour));
    const versions = storage.sourceVersions.get(candidate.sourceKey)!;
    const result = await cleanup(connection.db, storage, exactAt, enforceOptions());
    expect(storage.deletes).toEqual(versions.map((value) => ({ area: "quarantine", key: candidate.sourceKey, versionId: value.versionId })));
    expect(storage.sourceVersions.get(candidate.sourceKey)).toEqual([]);
    expect(result.results).toEqual([
      expect.objectContaining({
        assetId: candidate.assetId,
        disposition: "processed",
        bytesDeleted: 4,
        objectKeyHash: candidate.objectKeyHash,
      }),
    ]);
    const row = (await connection.db.select().from(publicMediaAssets).where(eq(publicMediaAssets.id, candidate.assetId)))[0]!;
    expect(row.sourceDeletedAt).toEqual(exactAt);
    expect(row.state).toBe("ready");
    expect(JSON.stringify(result)).not.toContain(candidate.sourceKey);
    for (const version of versions) expect(JSON.stringify(result)).not.toContain(version.versionId);
  });

  test("deletes and absence-verifies every real S3Mock source version and delete marker", async () => {
    const memory = new CleanupMemoryStorage();
    const candidate = await seedRuleCandidate(connection.db, memory, "processed_source", new Date(exactAt.getTime() - 24 * hour));
    const storage = createS3ObjectStorage({
      endpoint: s3Endpoint,
      region: s3Region,
      accessKeyId: s3AccessKeyId,
      secretAccessKey: s3SecretAccessKey,
      quarantineBucket,
      derivativeBucket,
      forcePathStyle: true,
    });
    let primaryFailed = false;
    try {
      await s3.send(new PutObjectCommand({
        Bucket: quarantineBucket,
        Key: candidate.sourceKey,
        Body: new Uint8Array([1, 2, 3, 4]),
        ContentType: "image/png",
        ContentLength: 4,
      }));
      await s3.send(new PutObjectCommand({
        Bucket: quarantineBucket,
        Key: candidate.sourceKey,
        Body: new Uint8Array([4, 3, 2, 1]),
        ContentType: "image/png",
        ContentLength: 4,
      }));
      await s3.send(new DeleteObjectCommand({ Bucket: quarantineBucket, Key: candidate.sourceKey }));
      expect(await storage.listObjectVersions({ area: "quarantine", key: candidate.sourceKey })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ isDeleteMarker: false }),
          expect.objectContaining({ isDeleteMarker: true }),
        ]),
      );

      const result = await cleanup(connection.db, storage, exactAt, enforceOptions());
      expect(result.results).toEqual([
        expect.objectContaining({ assetId: candidate.assetId, disposition: "processed", bytesDeleted: 4 }),
      ]);
      expect(await storage.listObjectVersions({ area: "quarantine", key: candidate.sourceKey })).toEqual([]);
      const row = (await connection.db.select().from(publicMediaAssets).where(eq(publicMediaAssets.id, candidate.assetId)))[0]!;
      expect(row.sourceDeletedAt).toEqual(exactAt);
    } catch (error) {
      primaryFailed = true;
      throw error;
    } finally {
      try {
        await deleteEveryS3ObjectVersion(s3, quarantineBucket, candidate.sourceKey);
      } catch (error) {
        if (!primaryFailed) throw error;
      }
    }
  });

  test.each(["ready_unreferenced", "superseded_derivative"] as const)("deletes exact %s versions, verifies absence, and retains immutable metadata", async (rule) => {
    const storage = new CleanupMemoryStorage();
    const age = rule === "ready_unreferenced" ? 30 * day : 180 * day;
    const candidate = await seedRuleCandidate(connection.db, storage, rule, new Date(exactAt.getTime() - age));
    const before = await connection.db.select().from(publicMediaDerivatives).where(eq(publicMediaDerivatives.assetId, candidate.assetId));
    const result = await cleanup(connection.db, storage, exactAt, enforceOptions());
    const derivativeDeletes = storage.deletes.filter((value) => value.area === "derivative");
    expect(derivativeDeletes).toEqual(before
      .map((row) => ({ area: "derivative" as const, key: row.objectKey, versionId: row.objectVersionId }))
      .sort((left, right) => left.key.localeCompare(right.key)));
    expect(result.results).toEqual([expect.objectContaining({ assetId: candidate.assetId, rule, disposition: "processed", bytesDeleted: 16 })]);
    const row = (await connection.db.select().from(publicMediaAssets).where(eq(publicMediaAssets.id, candidate.assetId)))[0]!;
    expect(row.state).toBe("deleted");
    expect(row.deletionReviewedAt).toEqual(exactAt);
    expect(await connection.db.select().from(publicMediaDerivatives).where(eq(publicMediaDerivatives.assetId, candidate.assetId))).toEqual(before);
  });

  test.each(["delete", "verification"])("leaves PostgreSQL undeleted and reports failed on provider %s failure", async (failure) => {
    const storage = new CleanupMemoryStorage();
    const candidate = await seedRuleCandidate(connection.db, storage, "ready_unreferenced", new Date(exactAt.getTime() - 30 * day));
    storage.failDelete = failure === "delete";
    storage.failVerify = failure === "verification";
    const result = await cleanup(connection.db, storage, exactAt, enforceOptions());
    expect(result.results).toEqual([expect.objectContaining({ assetId: candidate.assetId, disposition: "failed", bytesDeleted: 0 })]);
    const row = (await connection.db.select().from(publicMediaAssets).where(eq(publicMediaAssets.id, candidate.assetId)))[0]!;
    expect(row.state).toBe("ready");
    expect(row.deletionReviewedAt).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/provider-secret|derivatives\//u);
  });

  test("fails closed on malformed derivative HEAD evidence before deleting storage", async () => {
    const storage = new CleanupMemoryStorage();
    const candidate = await seedRuleCandidate(connection.db, storage, "ready_unreferenced", new Date(exactAt.getTime() - 30 * day));
    const originalHead = storage.headObject.bind(storage);
    storage.headObject = async (location) => {
      const evidence = await originalHead(location);
      return evidence === null ? null : { ...evidence, etag: " null " };
    };

    const result = await cleanup(connection.db, storage, exactAt, enforceOptions());

    expect(result.results).toEqual([
      expect.objectContaining({ assetId: candidate.assetId, disposition: "failed", bytesDeleted: 0 }),
    ]);
    expect(storage.deletes).toEqual([]);
    const row = (await connection.db.select().from(publicMediaAssets).where(eq(publicMediaAssets.id, candidate.assetId)))[0]!;
    expect(row.state).toBe("ready");
    expect(row.deletionReviewedAt).toBeNull();
  });

  test("fails closed on a malformed hold response before storage", async () => {
    const storage = new CleanupMemoryStorage();
    const candidate = await seedRuleCandidate(connection.db, storage, "processed_source", new Date(exactAt.getTime() - 24 * hour));
    const malformed = new Proxy(new Set([candidate.assetId]), { get() { throw new Error("hold-secret"); } });
    const result = await cleanup(connection.db, storage, exactAt, {
      ...enforceOptions(),
      holds: { protectedAssetIds: async () => malformed },
    });
    expect(result.results).toEqual([expect.objectContaining({ assetId: candidate.assetId, disposition: "failed" })]);
    expect(storage.deletes).toEqual([]);
  });

  test("uses skip-locked claims so concurrent scans do not process the same asset", async () => {
    const storage = new CleanupMemoryStorage();
    const locked = await seedRuleCandidate(connection.db, storage, "processed_source", new Date(exactAt.getTime() - 24 * hour), "00000000-0000-4000-8000-000000000501");
    const available = await seedRuleCandidate(connection.db, storage, "processed_source", new Date(exactAt.getTime() - 24 * hour), "00000000-0000-4000-8000-000000000502");
    let release!: () => void;
    let lockedSignal!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const acquired = new Promise<void>((resolve) => { lockedSignal = resolve; });
    const transaction = connection.db.transaction(async (tx) => {
      await tx.execute(sql`select id from public_media_assets where id = ${locked.assetId} for update`);
      lockedSignal();
      await waiting;
    });
    await acquired;
    try {
      const result = await cleanup(connection.db, storage, exactAt, { batchSize: 1 });
      expect(result.results.map((value) => value.assetId)).toEqual([available.assetId]);
    } finally {
      release();
      await transaction;
    }
  });

  test.each([0, 501, 1.5, Number.NaN])("rejects invalid batch limit %s before database or ports", async (batchSize) => {
    const db = new Proxy({}, { get() { throw new Error("database must not be read"); } });
    const storage = new Proxy({}, { get() { throw new Error("storage must not be read"); } });
    await expect(runPublicMediaCleanup({
      db: db as never,
      storage: storage as never,
      holds: { protectedAssetIds: async () => new Set() },
      now: exactAt,
      batchSize,
      mode: "report_only",
      retentionMode: "report_only",
      globalPause: true,
    })).rejects.toBeInstanceOf(PublicMediaCleanupConfigurationError);
  });
});

function enforceOptions() {
  return {
    mode: "enforce" as const,
    retentionMode: "enforce" as const,
    globalPause: false,
    acceptanceReference: "accepted-revision-3844c65",
  };
}

function cleanup(
  db: PawketDatabase,
  storage: ObjectStoragePort,
  now: Date,
  overrides: Record<string, unknown> = {},
) {
  return runPublicMediaCleanup({
    db,
    storage,
    holds: { protectedAssetIds: async () => new Set<string>() },
    now,
    batchSize: 500,
    mode: "report_only",
    retentionMode: "report_only",
    globalPause: true,
    ...overrides,
  } as never);
}

async function seedUser(db: PawketDatabase): Promise<string> {
  const userId = `cleanup-${randomUUID()}`;
  await db.insert(identityUsers).values({
    id: userId,
    name: "Cleanup creator",
    email: `${userId}@example.test`,
    canonicalEmail: `${userId}@example.test`,
    emailVerified: false,
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    updatedAt: new Date("2025-01-01T00:00:00.000Z"),
  });
  return userId;
}

async function seedFailedAsset(
  db: PawketDatabase,
  storage: CleanupMemoryStorage,
  failedAt: Date,
  assetId = randomUUID(),
) {
  const userId = await seedUser(db);
  const intentId = randomUUID();
  const sourceKey = `quarantine/${assetId}/${intentId}`;
  const createdAt = new Date(failedAt.getTime() - hour);
  await db.insert(publicMediaAssets).values({
    id: assetId,
    ownerUserId: userId,
    purpose: "showcase",
    declaredSourceFormat: "png",
    state: "awaiting_upload",
    sourceAllocationBytes: 4,
    sourceObjectKey: sourceKey,
    createdAt,
    updatedAt: createdAt,
  });
  await db.update(publicMediaAssets).set({ state: "failed", failureCode: "failed_validation", updatedAt: failedAt }).where(eq(publicMediaAssets.id, assetId));
  storage.seedSource(sourceKey);
  return {
    assetId,
    sourceKey,
    failedAt,
    objectKeyHash: createHash("sha256").update(sourceKey).digest("hex"),
  };
}

async function seedReadyAsset(
  db: PawketDatabase,
  storage: CleanupMemoryStorage,
  readyAt: Date,
  assetId = randomUUID(),
  sourceDeletedAt?: Date,
) {
  const userId = await seedUser(db);
  const intentId = randomUUID();
  const sourceKey = `quarantine/${assetId}/${intentId}`;
  const createdAt = new Date(readyAt.getTime() - hour);
  await db.insert(publicMediaAssets).values({
    id: assetId,
    ownerUserId: userId,
    purpose: "showcase",
    declaredSourceFormat: "png",
    state: "awaiting_upload",
    sourceAllocationBytes: 4,
    sourceObjectKey: sourceKey,
    createdAt,
    updatedAt: createdAt,
  });
  const completedAt = new Date(createdAt.getTime() + 60_000);
  await db.insert(publicMediaUploadIntents).values({
    id: intentId,
    assetId,
    ownerUserId: userId,
    purpose: "showcase",
    declaredSourceFormat: "png",
    maxSourceBytes: 4,
    maxSourcePixels: 40_000_000,
    objectKey: sourceKey,
    state: "issued",
    expiresAt: new Date(createdAt.getTime() + 15 * 60_000),
    completedAt: null,
    createdAt,
    updatedAt: createdAt,
  });
  await db.update(publicMediaUploadIntents).set({ state: "completed", completedAt, updatedAt: completedAt }).where(eq(publicMediaUploadIntents.id, intentId));
  await db.update(publicMediaAssets).set({ state: "pending", sourceObjectVersionId: "source-version-1", sourceObjectEtag: "source-etag-1", actualSourceBytes: 4, updatedAt: completedAt }).where(eq(publicMediaAssets.id, assetId));
  await db.update(publicMediaAssets).set({ state: "processing", updatedAt: readyAt }).where(eq(publicMediaAssets.id, assetId));
  const derivatives = (["master", "thumb", "display", "large"] as const).map((variant) => ({
    id: randomUUID(),
    assetId,
    variant,
    format: "webp",
    width: variant === "master" ? 32 : variant === "large" ? 24 : variant === "display" ? 16 : 8,
    height: 8,
    byteSize: 4,
    contentHash: `sha256:v1:${"a".repeat(43)}`,
    objectKey: `derivatives/${assetId}/${variant}/${variant}-hash.webp`,
    objectVersionId: `${variant}-version-1`,
    verifiedAt: readyAt,
    createdAt: readyAt,
    updatedAt: readyAt,
  }));
  await db.insert(publicMediaDerivatives).values(derivatives);
  await db.update(publicMediaAssets).set({
    state: "ready",
    normalizedMasterObjectKey: derivatives[0]!.objectKey,
    normalizedMasterObjectVersionId: derivatives[0]!.objectVersionId,
    width: 32,
    height: 8,
    readyAt,
    updatedAt: readyAt,
  }).where(eq(publicMediaAssets.id, assetId));
  if (sourceDeletedAt) {
    await db.update(publicMediaAssets).set({ sourceDeletedAt, updatedAt: sourceDeletedAt }).where(eq(publicMediaAssets.id, assetId));
  } else {
    storage.seedSource(sourceKey);
  }
  for (const derivative of derivatives) storage.seedDerivative(derivative.objectKey, derivative.objectVersionId, derivative.byteSize, derivative.contentHash);
  return {
    assetId,
    userId,
    sourceKey,
    readyAt,
    objectKeyHash: createHash("sha256").update(sourceKey).digest("hex"),
  };
}

async function seedRuleCandidate(
  db: PawketDatabase,
  storage: CleanupMemoryStorage,
  rule: PublicMediaCleanupRule,
  ruleAt: Date,
  assetId = randomUUID(),
) {
  if (rule === "failed_quarantine") return seedFailedAsset(db, storage, ruleAt, assetId);
  if (rule === "processed_source") return seedReadyAsset(db, storage, ruleAt, assetId);
  const readyAt = rule === "ready_unreferenced" ? ruleAt : new Date(ruleAt.getTime() - 10 * day);
  const asset = await seedReadyAsset(db, storage, readyAt, assetId, new Date(readyAt.getTime() + 24 * hour));
  if (rule === "superseded_derivative") await seedSupersededRevision(db, asset.userId, asset.assetId, readyAt, ruleAt);
  return asset;
}

async function seedSupersededRevision(db: PawketDatabase, userId: string, assetId: string, publishedAt: Date, leftLiveAt: Date): Promise<void> {
  const pageId = randomUUID();
  const revisionId = randomUUID();
  await db.insert(creatorPages).values({ id: pageId, userId, draftVersion: 1, publishedRevisionId: null, initializedFromRevisionId: randomUUID(), createdAt: publishedAt, updatedAt: leftLiveAt });
  await db.insert(creatorPageDrafts).values({ pageId, displayName: "Cleanup", shortIntroduction: "Cleanup", primaryDiscipline: "illustration", secondaryDisciplines: [], avatarAssetId: null, coverAssetId: null, createdAt: publishedAt, updatedAt: publishedAt });
  await db.insert(creatorPublicationRevisions).values({ id: revisionId, pageId, revisionNumber: 1, canonicalHandle: `cleanup-${assetId.slice(-8)}`, displayName: "Cleanup", shortIntroduction: "Cleanup", primaryDiscipline: "illustration", secondaryDisciplines: [], avatarAssetId: assetId, avatarThumbDerivativeId: null, avatarDisplayDerivativeId: null, coverAssetId: null, coverDisplayDerivativeId: null, taxonomyVersion: "creator-discipline-v1", policyVersion: "general-audience-v1", actorUserId: userId, actorSessionId: "cleanup-session", expectedDraftVersion: 1, requestId: `cleanup-${assetId}`, publishedAt });
  await db.insert(creatorPublicationEvents).values([
    { id: randomUUID(), pageId, revisionId, type: "published", actorUserId: userId, actorSessionId: "cleanup-session", expectedDraftVersion: 1, requestId: `published-${assetId}`, occurredAt: publishedAt },
    { id: randomUUID(), pageId, revisionId, type: "unpublished", actorUserId: userId, actorSessionId: "cleanup-session", expectedDraftVersion: 1, requestId: `unpublished-${assetId}`, occurredAt: leftLiveAt },
  ]);
}
