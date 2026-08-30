import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { S3Client } from "@aws-sdk/client-s3";

import { createDatabase, identityUsers, publicMediaAssets, publicMediaDerivatives, publicMediaUploadIntents, systemCommandIdempotency, systemOutbox, type PawketDatabase } from "@pawket/database";

import { createPublicMediaService } from "../src/media-service.js";
import { createS3ObjectStorage } from "../src/s3-object-storage.js";
import { deleteEveryObjectVersion, ensureVersionedBuckets } from "./s3-test-helpers.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = new URL("../../database/migrations/", import.meta.url);
const at = new Date("2026-08-30T05:00:00.000Z");
let db: PawketDatabase | undefined;
let close: (() => Promise<void>) | undefined;
let schemaName: string;

async function migrate(filename: string): Promise<void> {
  const migration = await readFile(new URL(filename, migrationsDirectory), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) if (statement.trim()) await db!.execute(sql.raw(statement));
}

describe("public media service", () => {
  test("fails closed for fresh mutations while publishing is disabled", async () => {
    const service = createPublicMediaService({
      db: { transaction: async (callback: (tx: never) => unknown) => callback({} as never) } as never,
      storage: {} as never,
      creator: { getActiveCreator: async () => ({ userId: "creator-1", state: "active" }) },
      catalog: { ownsAsset: async () => true },
      publishingMode: "disabled",
    });
    await expect(service.createUploadIntent({ actor: { userId: "creator-1" }, purpose: "showcase", declaredSourceFormat: "png", contentType: "image/png", declaredBytes: 12, idempotencyKey: "disabled-key-1", requestId: "disabled-request-1" })).rejects.toMatchObject({ code: "PUBLISHING_DISABLED" });
  });

  test("does not call storage for a disabled mutation", async () => {
    const presign = vi.fn();
    const service = createPublicMediaService({ db: { transaction: async (callback: (tx: never) => unknown) => callback({} as never) } as never, storage: { presignPut: presign } as never, creator: { getActiveCreator: async () => ({ userId: "creator-1", state: "active" }) }, catalog: { ownsAsset: async () => true }, publishingMode: "disabled" });
    await expect(service.createUploadIntent({ actor: { userId: "creator-1" }, purpose: "avatar", declaredSourceFormat: "jpeg", contentType: "image/jpeg", declaredBytes: 12, idempotencyKey: "disabled-key-2", requestId: "disabled-request-2" })).rejects.toMatchObject({ code: "PUBLISHING_DISABLED" });
    expect(presign).not.toHaveBeenCalled();
  });

  test("rejects omitted, undefined, and legacy-extra command fields before database access", async () => {
    const transaction = vi.fn();
    const service = createPublicMediaService({ db: { transaction } as never, storage: {} as never, creator: {} as never, catalog: {} as never, publishingMode: "general_audience" });
    const create = { actor: { userId: "creator-1" }, purpose: "showcase", declaredSourceFormat: "png", contentType: "image/png", declaredBytes: 12, idempotencyKey: "strict-key-1", requestId: "strict-request-1" } as const;
    await expect(service.createUploadIntent({ ...create, contentType: undefined } as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(service.createUploadIntent({ ...create, declaredSourceFormat: undefined } as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(service.createUploadIntent({ ...create, declaredBytes: undefined } as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(service.createUploadIntent({ ...create, idempotencyKey: undefined } as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(service.createUploadIntent({ ...create, requestId: undefined } as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(service.createUploadIntent({ ...create, contentLength: 12 } as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(service.completeUpload({ actor: create.actor, assetId: "00000000-0000-4000-8000-000000000001", intentId: "00000000-0000-4000-8000-000000000002", idempotencyKey: undefined, requestId: "strict-request-2" } as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(service.completeUpload({ actor: create.actor, assetId: "00000000-0000-4000-8000-000000000001", intentId: "00000000-0000-4000-8000-000000000002", idempotencyKey: "strict-key-2", requestId: undefined } as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(service.completeUpload({ actor: create.actor, assetId: "00000000-0000-4000-8000-000000000001", intentId: "00000000-0000-4000-8000-000000000002", idempotencyKey: "strict-key-2", requestId: "strict-request-2", contentLength: 12 } as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(transaction).not.toHaveBeenCalled();
  });

  test("closes malformed readiness inputs without touching the database", async () => {
    const forbiddenDb = new Proxy({}, { get() { throw new Error("database must not be called"); } }) as never;
    const service = createPublicMediaService({ db: forbiddenDb, storage: {} as never, creator: {} as never, catalog: {} as never, publishingMode: "general_audience" });
    const malformedReference = Object.defineProperty({}, "assetId", { get() { throw new Error("getter must not run"); }, enumerable: true });
    await expect(service.resolveReadyAssets(forbiddenDb, "owner-001", [null] as never)).resolves.toEqual(new Map());
    await expect(service.resolveReadyAssets(forbiddenDb, "owner-001", [malformedReference] as never)).resolves.toEqual(new Map());
    await expect(service.resolveReadyAssetsBatch(forbiddenDb, null as never)).resolves.toEqual(new Map());
    await expect(service.resolveReadyAssetsBatch(forbiddenDb, [{ ownerUserId: "owner-001", references: [malformedReference] }] as never)).resolves.toEqual(new Map());
    const validEmptyBatch = await service.resolveReadyAssetsBatch(forbiddenDb, [{ ownerUserId: "owner-001", references: [] }]);
    expect(Object.getPrototypeOf(validEmptyBatch)).toBe(Map.prototype);
    expect(validEmptyBatch).toEqual(new Map([["owner-001", new Map()]]));
    expect(Object.getPrototypeOf(validEmptyBatch.get("owner-001"))).toBe(Map.prototype);
  });

  test.skipIf(!databaseUrl)("creates and completes an owned upload in one PostgreSQL transaction", async () => {
    schemaName = `public_media_${process.pid}_${Date.now()}`;
    const root = createDatabase(databaseUrl!);
    await root.db.execute(sql.raw(`create schema "${schemaName}"`));
    await root.close();
    const connection = createDatabase(`${databaseUrl!}?options=-csearch_path%3D${schemaName},public`);
    db = connection.db; close = connection.close;
    for (const file of (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort()) await migrate(file);
    const userId = `media-${randomUUID()}`;
    const opaqueVersionId = `a/+=${"x".repeat(508)}`;
    await db.insert(identityUsers).values({ id: userId, name: "Media creator", email: `${userId}@example.test`, canonicalEmail: `${userId}@example.test`, emailVerified: false, createdAt: at, updatedAt: at });
    const ids = [randomUUID(), randomUUID()];
    const storage = {
      async presignPut(input: { key: string; contentType: string; contentLength: number; expiresInSeconds: 900 }) { return { url: "https://upload.invalid/signed", requiredHeaders: { "content-type": input.contentType, "content-length": String(input.contentLength) }, expiresAt: new Date(at.getTime() + input.expiresInSeconds * 1000) }; },
      async headObject() { return { contentLength: 3, contentType: "image/png", etag: "\"etag-v1\"", versionId: opaqueVersionId, sha256: null }; },
    };
    const service = createPublicMediaService({ db, storage: storage as never, publishingMode: "general_audience", creator: { getActiveCreator: async () => ({ userId, state: "active" }) }, catalog: { ownsAsset: async () => true }, commandFingerprintKey: new Uint8Array(32).fill(7), now: () => at, idFactory: () => ids.shift()! });
    const intent = await service.createUploadIntent({ actor: { userId }, purpose: "showcase", declaredSourceFormat: "png", contentType: "image/png", declaredBytes: 3, idempotencyKey: "media-intent-1", requestId: "media-request-1" });
    const completed = await service.completeUpload({ actor: { userId }, assetId: intent.assetId, intentId: intent.intentId, idempotencyKey: "media-complete-1", requestId: "media-complete-request-1" });
    expect(completed).toMatchObject({ assetId: intent.assetId, intentId: intent.intentId, state: "pending", sourceObjectVersionId: opaqueVersionId, actualSourceBytes: 3 });
    const completionRecords = await db.select().from(systemCommandIdempotency).where(eq(systemCommandIdempotency.commandScope, "public-media.upload-complete"));
    expect(completionRecords).toHaveLength(1);
    expect(completionRecords[0]!.resultReference).toBe(`media-complete-v2:${intent.assetId}:${intent.intentId}:3`);
    expect(completionRecords[0]!.resultReference).not.toContain(opaqueVersionId);
    expect(completionRecords[0]!.resultReference!.length).toBeLessThanOrEqual(200);
    const replay = await service.completeUpload({ actor: { userId }, assetId: intent.assetId, intentId: intent.intentId, idempotencyKey: "media-complete-1", requestId: "media-complete-request-1" });
    expect(replay).toEqual(completed);
    await db.update(systemCommandIdempotency).set({ resultReference: `media-complete-v2:${intent.assetId}:${intent.intentId}:4` }).where(eq(systemCommandIdempotency.id, completionRecords[0]!.id));
    await expect(service.completeUpload({ actor: { userId }, assetId: intent.assetId, intentId: intent.intentId, idempotencyKey: "media-complete-1", requestId: "media-complete-request-1" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect((await db.select().from(publicMediaAssets).where(eq(publicMediaAssets.id, intent.assetId)))[0]).toMatchObject({ state: "pending", sourceObjectVersionId: opaqueVersionId, actualSourceBytes: 3 });
    expect((await db.select().from(publicMediaUploadIntents).where(eq(publicMediaUploadIntents.id, intent.intentId)))[0]).toMatchObject({ state: "completed" });
    expect((await db.select().from(systemOutbox).where(eq(systemOutbox.aggregateId, intent.assetId))).map((event) => event.eventType)).toContain("media.public_upload_completed.v1");

    const derivativeIds = { master: randomUUID(), thumb: randomUUID(), display: randomUUID(), large: randomUUID() } as const;
    const dimensions = { master: 4096, thumb: 384, display: 1280, large: 2400 } as const;
    await db.update(publicMediaAssets).set({ state: "processing", updatedAt: at }).where(eq(publicMediaAssets.id, intent.assetId));
    for (const variant of ["master", "thumb", "display", "large"] as const) {
      await db.insert(publicMediaDerivatives).values({
        id: derivativeIds[variant],
        assetId: intent.assetId,
        variant,
        format: "webp",
        width: dimensions[variant],
        height: 300,
        byteSize: 2,
        contentHash: `sha256:v1:${"a".repeat(43)}`,
        objectKey: `derivatives/${intent.assetId}/${variant}/${variant}-hash.webp`,
        objectVersionId: `provider/${variant}+=._~-`,
        verifiedAt: at,
        createdAt: at,
        updatedAt: at,
      });
    }
    await db.update(publicMediaAssets).set({ state: "ready", readyAt: at, width: 4096, height: 300, normalizedMasterObjectKey: `derivatives/${intent.assetId}/master/master-hash.webp`, normalizedMasterObjectVersionId: "provider/master+=._~-", updatedAt: at }).where(eq(publicMediaAssets.id, intent.assetId));
    const references = [{ assetId: intent.assetId, purpose: "showcase", altText: "Original art" }] as const;
    const expectedReady = {
      assetId: intent.assetId,
      ownerUserId: userId,
      purpose: "showcase" as const,
      derivatives: {
        thumb: { derivativeId: derivativeIds.thumb, width: 384, height: 300 },
        display: { derivativeId: derivativeIds.display, width: 1280, height: 300 },
        large: { derivativeId: derivativeIds.large, width: 2400, height: 300 },
      },
    };
    const singleReady = await service.resolveReadyAssets(db, userId, references);
    expect(Object.getPrototypeOf(singleReady)).toBe(Map.prototype);
    expect(singleReady).toEqual(new Map([[intent.assetId, expectedReady]]));
    const emptyOwnerUserId = "empty-owner-001";
    const batchReady = await service.resolveReadyAssetsBatch(db, [{ ownerUserId: userId, references }, { ownerUserId: emptyOwnerUserId, references: [] }]);
    expect(Object.getPrototypeOf(batchReady)).toBe(Map.prototype);
    expect(batchReady).toEqual(new Map([[userId, new Map([[intent.assetId, expectedReady]])], [emptyOwnerUserId, new Map()]]));
    expect(Object.getPrototypeOf(batchReady.get(userId))).toBe(Map.prototype);
    expect(Object.getPrototypeOf(batchReady.get(emptyOwnerUserId))).toBe(Map.prototype);
    await close(); close = undefined;
    const cleanup = createDatabase(databaseUrl!); await cleanup.db.execute(sql.raw(`drop schema if exists "${schemaName}" cascade`)); await cleanup.close();
  });

  test.skipIf(!databaseUrl)("serializes the 500 MiB allocation with exactly 50 ten-MiB winners", async () => {
    schemaName = `public_media_quota_${process.pid}_${Date.now()}`;
    const root = createDatabase(databaseUrl!);
    await root.db.execute(sql.raw(`create schema "${schemaName}"`)); await root.close();
    const connection = createDatabase(`${databaseUrl!}?options=-csearch_path%3D${schemaName},public`); db = connection.db; close = connection.close;
    for (const file of (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort()) await migrate(file);
    const userId = `quota-${randomUUID()}`;
    await db.insert(identityUsers).values({ id: userId, name: "Quota creator", email: `${userId}@example.test`, canonicalEmail: `${userId}@example.test`, emailVerified: false, createdAt: at, updatedAt: at });
    const storage = { async presignPut(input: { expiresInSeconds: number; contentType: string; contentLength: number; key: string }) { return { url: "https://upload.invalid/signed", requiredHeaders: { "content-type": input.contentType, "content-length": String(input.contentLength) }, expiresAt: new Date(at.getTime() + input.expiresInSeconds * 1000) }; } };
    const service = createPublicMediaService({ db, storage: storage as never, publishingMode: "general_audience", creator: { getActiveCreator: async () => ({ userId, state: "active" }) }, catalog: { ownsAsset: async () => true }, now: () => at });
    const results = await Promise.allSettled(Array.from({ length: 51 }, (_, index) => service.createUploadIntent({ actor: { userId }, purpose: "showcase", declaredSourceFormat: "png", contentType: "image/png", declaredBytes: 10 * 1024 * 1024, idempotencyKey: `quota-key-${index.toString().padStart(2, "0")}`, requestId: `quota-request-${index.toString().padStart(2, "0")}` })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(50);
    await close(); close = undefined;
    const cleanup = createDatabase(databaseUrl!); await cleanup.db.execute(sql.raw(`drop schema if exists "${schemaName}" cascade`)); await cleanup.close();
  });

  test.skipIf(!databaseUrl)("pins the first S3Mock version across overwrite and completion replay", async () => {
    schemaName = `public_media_s3_e2e_${process.pid}_${Date.now()}`;
    const root = createDatabase(databaseUrl!);
    await root.db.execute(sql.raw(`create schema "${schemaName}"`));
    await root.close();
    const connection = createDatabase(`${databaseUrl!}?options=-csearch_path%3D${schemaName},public`);
    db = connection.db; close = connection.close;
    const endpoint = process.env.PUBLIC_MEDIA_S3_ENDPOINT ?? "http://localhost:9090";
    const region = process.env.PUBLIC_MEDIA_S3_REGION ?? "us-east-1";
    const accessKeyId = process.env.PUBLIC_MEDIA_S3_ACCESS_KEY_ID ?? "local-media-access-key";
    const secretAccessKey = process.env.PUBLIC_MEDIA_S3_SECRET_ACCESS_KEY ?? "local-media-secret-key";
    const quarantineBucket = process.env.PUBLIC_MEDIA_QUARANTINE_BUCKET ?? "pawket-media-quarantine";
    const derivativeBucket = process.env.PUBLIC_MEDIA_DERIVATIVE_BUCKET ?? "pawket-media-derivatives";
    const s3Client = new S3Client({ endpoint, region, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
    const userId = `s3-e2e-${randomUUID()}`;
    const sharedNow = new Date();
    const storage = createS3ObjectStorage({ endpoint, region, accessKeyId, secretAccessKey, quarantineBucket, derivativeBucket, forcePathStyle: true, now: () => sharedNow });
    const service = createPublicMediaService({ db, storage, publishingMode: "general_audience", creator: { getActiveCreator: async () => ({ userId, state: "active" }) }, catalog: { ownsAsset: async () => true }, now: () => sharedNow });
    let objectKey: string | undefined;
    try {
      await ensureVersionedBuckets(s3Client, [quarantineBucket, derivativeBucket]);
      for (const file of (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort()) await migrate(file);
      await db.insert(identityUsers).values({ id: userId, name: "S3 E2E creator", email: `${userId}@example.test`, canonicalEmail: `${userId}@example.test`, emailVerified: false, createdAt: at, updatedAt: at });
      const intent = await service.createUploadIntent({ actor: { userId }, purpose: "showcase", declaredSourceFormat: "png", contentType: "image/png", declaredBytes: 3, idempotencyKey: "s3-e2e-intent-1", requestId: "s3-e2e-request-1" });
      objectKey = `quarantine/${intent.assetId}/${intent.intentId}`;
      const firstBytes = new Uint8Array([1, 2, 3]);
      const secondBytes = new Uint8Array([7, 8, 9]);
      const firstPut = await fetch(intent.url, { method: "PUT", headers: intent.requiredHeaders, body: firstBytes });
      expect(firstPut.ok).toBe(true);
      const completed = await service.completeUpload({ actor: { userId }, assetId: intent.assetId, intentId: intent.intentId, idempotencyKey: "s3-e2e-complete-1", requestId: "s3-e2e-complete-request-1" });
      const secondPut = await fetch(intent.url, { method: "PUT", headers: intent.requiredHeaders, body: secondBytes });
      expect(secondPut.ok).toBe(true);
      const current = await storage.headObject({ area: "quarantine", key: objectKey });
      expect(current?.versionId).not.toBe(completed.sourceObjectVersionId);
      expect((await db.select().from(publicMediaAssets).where(eq(publicMediaAssets.id, intent.assetId)))[0]?.sourceObjectVersionId).toBe(completed.sourceObjectVersionId);
      const replay = await service.completeUpload({ actor: { userId }, assetId: intent.assetId, intentId: intent.intentId, idempotencyKey: "s3-e2e-complete-1", requestId: "s3-e2e-complete-request-1" });
      expect(replay).toEqual(completed);
      expect((await db.select().from(systemOutbox).where(eq(systemOutbox.aggregateId, intent.assetId)))).toHaveLength(1);
      const firstRead = await storage.getObject({ area: "quarantine", key: objectKey, versionId: completed.sourceObjectVersionId });
      const chunks: Uint8Array[] = [];
      for await (const chunk of firstRead as AsyncIterable<Uint8Array>) chunks.push(chunk);
      expect(Buffer.concat(chunks)).toEqual(Buffer.from(firstBytes));
    } finally {
      try {
        if (objectKey) {
          await deleteEveryObjectVersion(storage, { area: "quarantine", key: objectKey });
          expect(await storage.listObjectVersions({ area: "quarantine", key: objectKey })).toEqual([]);
        }
      } finally {
        s3Client.destroy();
        await close?.(); close = undefined;
        const cleanup = createDatabase(databaseUrl!); await cleanup.db.execute(sql.raw(`drop schema if exists "${schemaName}" cascade`)); await cleanup.close();
      }
    }
  });
});
