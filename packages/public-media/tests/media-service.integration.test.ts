import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

import { createDatabase, identityUsers, publicMediaAssets, publicMediaUploadIntents, systemOutbox, type PawketDatabase } from "@pawket/database";

import { createPublicMediaService } from "../src/media-service.js";

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
      publishingMode: "disabled",
    });
    await expect(service.createUploadIntent({ actor: { userId: "creator-1" }, purpose: "showcase", contentType: "image/png", declaredBytes: 12 })).rejects.toMatchObject({ code: "PUBLISHING_DISABLED" });
  });

  test("does not call storage for a disabled mutation", async () => {
    const presign = vi.fn();
    const service = createPublicMediaService({ db: { transaction: async (callback: (tx: never) => unknown) => callback({} as never) } as never, storage: { presignPut: presign } as never, creator: { getActiveCreator: async () => ({ userId: "creator-1", state: "active" }) }, publishingMode: "disabled" });
    await expect(service.createUploadIntent({ actor: { userId: "creator-1" }, purpose: "avatar", contentType: "image/jpeg", declaredBytes: 12 })).rejects.toMatchObject({ code: "PUBLISHING_DISABLED" });
    expect(presign).not.toHaveBeenCalled();
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
    await db.insert(identityUsers).values({ id: userId, name: "Media creator", email: `${userId}@example.test`, canonicalEmail: `${userId}@example.test`, emailVerified: false, createdAt: at, updatedAt: at });
    const ids = [randomUUID(), randomUUID()];
    const storage = {
      async presignPut(input: { key: string; contentType: string; contentLength: number; expiresInSeconds: 900 }) { return { url: "https://upload.invalid/signed", requiredHeaders: { "content-type": input.contentType, "content-length": String(input.contentLength) }, expiresAt: new Date(at.getTime() + input.expiresInSeconds * 1000) }; },
      async headObject() { return { contentLength: 3, contentType: "image/png", etag: "\"etag-v1\"", versionId: "version-v1", sha256: null }; },
    };
    const service = createPublicMediaService({ db, storage: storage as never, publishingMode: "general_audience", creator: { getActiveCreator: async () => ({ userId, state: "active" }) }, commandFingerprintKey: new Uint8Array(32).fill(7), now: () => at, idFactory: () => ids.shift()! });
    const intent = await service.createUploadIntent({ actor: { userId }, purpose: "showcase", contentType: "image/png", declaredBytes: 3, idempotencyKey: "media-intent-1" });
    const completed = await service.completeUpload({ actor: { userId }, assetId: intent.assetId, intentId: intent.intentId, idempotencyKey: "media-complete-1" });
    expect(completed).toMatchObject({ assetId: intent.assetId, intentId: intent.intentId, state: "pending", sourceObjectVersionId: "version-v1", actualSourceBytes: 3 });
    expect((await db.select().from(publicMediaAssets).where(eq(publicMediaAssets.id, intent.assetId)))[0]).toMatchObject({ state: "pending", sourceObjectVersionId: "version-v1", actualSourceBytes: 3 });
    expect((await db.select().from(publicMediaUploadIntents).where(eq(publicMediaUploadIntents.id, intent.intentId)))[0]).toMatchObject({ state: "completed" });
    expect((await db.select().from(systemOutbox).where(eq(systemOutbox.aggregateId, intent.assetId))).map((event) => event.eventType)).toContain("media.public_upload_completed.v1");
    await close(); close = undefined;
    const cleanup = createDatabase(databaseUrl!); await cleanup.db.execute(sql.raw(`drop schema if exists "${schemaName}" cascade`)); await cleanup.close();
  });
});
