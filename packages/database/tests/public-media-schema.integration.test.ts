import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  publicMediaAssets,
  publicMediaDerivatives,
  publicMediaProcessingAttempts,
  publicMediaUploadIntents,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://pawket:pawket_dev_only@127.0.0.1:5432/pawket_dev";
const migrationsFolder = fileURLToPath(new URL("../migrations/", import.meta.url));
const admin = postgres(databaseUrl, { max: 1 });
const schemaName = `public_media_${process.pid}_${Date.now()}`;
const journalSchema = `${schemaName}_journal`;
let client: postgres.Sql;
let db: ReturnType<typeof drizzle>;

const at = "2026-08-29T12:00:00.000Z";
const later = "2026-08-29T12:15:00.000Z";

async function fixture() {
  const userId = `media-user-${randomUUID()}`;
  const assetId = randomUUID();
  const intentId = randomUUID();
  await client.unsafe(`
    insert into identity_users
      (id, name, email, canonical_email, email_verified, email_verified_at,
       email_verification_provenance, access_status, authorization_version, created_at, updated_at)
    values ('${userId}', 'Media User', '${userId}@example.com', '${userId}@example.com', true,
      '${at}', 'password_email_challenge', 'active', 1, '${at}', '${at}')
  `);
  await db.insert(publicMediaAssets).values({
    id: assetId,
    ownerUserId: userId,
    purpose: "showcase",
    declaredSourceFormat: "jpeg",
    state: "awaiting_upload",
    sourceAllocationBytes: 1024,
    sourceObjectKey: `quarantine/${assetId}/${intentId}`,
    createdAt: new Date(at),
    updatedAt: new Date(at),
  });
  return { userId, assetId, intentId };
}

async function insertIntent(assetId: string, ownerUserId: string, intentId = randomUUID()) {
  await db.insert(publicMediaUploadIntents).values({
    id: intentId,
    assetId,
    ownerUserId,
    purpose: "showcase",
    declaredSourceFormat: "jpeg",
    maxSourceBytes: 10 * 1024 * 1024,
    maxSourcePixels: 40_000_000,
    objectKey: `quarantine/${assetId}/${intentId}`,
    expiresAt: new Date(later),
    state: "issued",
    createdAt: new Date(at),
    updatedAt: new Date(at),
  });
}

async function insertDerivative(assetId: string, variant: "master" | "thumb" | "display" | "large") {
  await db.insert(publicMediaDerivatives).values({
    id: randomUUID(),
    assetId,
    variant,
    format: "webp",
    width: variant === "thumb" ? 384 : variant === "display" ? 1280 : variant === "large" ? 2400 : 4096,
    height: 300,
    byteSize: 100,
    contentHash: `sha256:v1:${"a".repeat(43)}`,
    objectKey: `derivatives/${assetId}/${variant}/hash.webp`,
    objectVersionId: `version-${variant}`,
    verifiedAt: new Date(at),
    createdAt: new Date(at),
    updatedAt: new Date(at),
  });
}

describe("public media persistence", () => {
  beforeAll(async () => {
    await admin.unsafe(`create schema "${schemaName}"`);
    client = postgres(databaseUrl, { max: 1 });
    await client.unsafe(`set search_path to "${schemaName}", public`);
    db = drizzle(client);
    await migrate(db, { migrationsFolder, migrationsSchema: journalSchema });
  });

  afterAll(async () => {
    await client.end();
    await admin.unsafe(`drop schema if exists "${schemaName}" cascade`);
    await admin.end();
  });

  test("exports all authoritative media tables and enforces one intent per asset and variant", async () => {
    const f = await fixture();
    await insertIntent(f.assetId, f.userId, f.intentId);
    await expect(insertIntent(f.assetId, f.userId)).rejects.toThrow();
    await insertDerivative(f.assetId, "thumb");
    await expect(insertDerivative(f.assetId, "thumb")).rejects.toThrow();
  });

  test("ready requires all four verified fixed derivatives", async () => {
    const f = await fixture();
    await client.unsafe(`update public_media_assets set state = 'pending' where id = '${f.assetId}'`);
    await client.unsafe(`update public_media_assets set state = 'processing' where id = '${f.assetId}'`);
    await expect(client.unsafe(`update public_media_assets set state = 'ready' where id = '${f.assetId}'`)).rejects.toThrow(/require/i);
    await insertDerivative(f.assetId, "master");
    await insertDerivative(f.assetId, "thumb");
    await insertDerivative(f.assetId, "display");
    await expect(client.unsafe(`update public_media_assets set state = 'ready' where id = '${f.assetId}'`)).rejects.toThrow(/require/i);
    await insertDerivative(f.assetId, "large");
    await client.unsafe(`update public_media_assets set state = 'ready', ready_at = '${at}', width = 4096, height = 300,
      normalized_master_object_key = 'derivatives/${f.assetId}/master/hash.webp', normalized_master_object_version_id = 'version-master'
      where id = '${f.assetId}'`);
  });

  test("closes purpose/source/state/variant/format and numeric boundaries", async () => {
    const f = await fixture();
    const checks = [
      `update public_media_assets set purpose = 'other' where id = '${f.assetId}'`,
      `update public_media_assets set declared_source_format = 'gif' where id = '${f.assetId}'`,
      `update public_media_assets set state = 'unknown' where id = '${f.assetId}'`,
      `update public_media_assets set source_allocation_bytes = -1 where id = '${f.assetId}'`,
    ];
    for (const statement of checks) await expect(client.unsafe(statement)).rejects.toThrow();
    await insertIntent(f.assetId, f.userId);
    await expect(client.unsafe(`update public_media_upload_intents set expires_at = '${at}' where asset_id = '${f.assetId}'`)).rejects.toThrow();
    await insertDerivative(f.assetId, "thumb");
    await expect(client.unsafe(`update public_media_derivatives set variant = 'original' where asset_id = '${f.assetId}'`)).rejects.toThrow();
    await expect(client.unsafe(`update public_media_derivatives set format = 'png' where asset_id = '${f.assetId}'`)).rejects.toThrow();
    await expect(client.unsafe(`update public_media_derivatives set byte_size = 0 where asset_id = '${f.assetId}'`)).rejects.toThrow();
  });

  test("prevents terminal attempt mutation and asset terminal escape", async () => {
    const f = await fixture();
    const attemptId = randomUUID();
    await db.insert(publicMediaProcessingAttempts).values({
      id: attemptId,
      assetId: f.assetId,
      attemptNumber: 1,
      workerId: "worker-1",
      outcomeCode: "failed_validation",
      startedAt: new Date(at),
      finishedAt: new Date(later),
      nextRetryAt: null,
      createdAt: new Date(at),
      updatedAt: new Date(later),
    });
    await expect(client.unsafe(`update public_media_processing_attempts set outcome_code = 'succeeded' where id = '${attemptId}'`)).rejects.toThrow();
    await expect(client.unsafe(`delete from public_media_processing_attempts where id = '${attemptId}'`)).rejects.toThrow();
    await client.unsafe(`update public_media_assets set state = 'pending' where id = '${f.assetId}'`);
    await client.unsafe(`update public_media_assets set state = 'failed', failure_code = 'failed_validation' where id = '${f.assetId}'`);
    await expect(client.unsafe(`update public_media_assets set state = 'pending' where id = '${f.assetId}'`)).rejects.toThrow();
  });

  test("allows only reviewed ready cleanup and freezes derivatives at terminal states", async () => {
    const f = await fixture();
    await client.unsafe(`update public_media_assets set state = 'pending' where id = '${f.assetId}'`);
    await client.unsafe(`update public_media_assets set state = 'processing' where id = '${f.assetId}'`);
    for (const variant of ["master", "thumb", "display", "large"] as const) await insertDerivative(f.assetId, variant);
    await client.unsafe(`update public_media_assets set state = 'ready', ready_at = '${at}', width = 4096, height = 300,
      normalized_master_object_key = 'derivatives/${f.assetId}/master/hash.webp', normalized_master_object_version_id = 'version-master'
      where id = '${f.assetId}'`);
    await expect(client.unsafe(`update public_media_derivatives set byte_size = 101 where asset_id = '${f.assetId}'`)).rejects.toThrow();
    await expect(client.unsafe(`delete from public_media_derivatives where asset_id = '${f.assetId}'`)).rejects.toThrow();
    await expect(client.unsafe(`update public_media_assets set state = 'deleted' where id = '${f.assetId}'`)).rejects.toThrow();
    await client.unsafe(`update public_media_assets set state = 'deleted', deletion_reviewed_at = '${later}' where id = '${f.assetId}'`);
    await expect(client.unsafe(`update public_media_assets set state = 'ready' where id = '${f.assetId}'`)).rejects.toThrow();
  });

  test("keeps source and object identity private and has worker/quota/cleanup indexes", async () => {
    const columns = await client<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = ${schemaName} and table_name = 'public_media_assets'
      order by ordinal_position
    `;
    expect(columns.map((row) => row.column_name)).not.toContain("original_filename");
    expect(columns.map((row) => row.column_name)).not.toContain("public_url");
    const indexes = await client<{ indexname: string }[]>`
      select indexname from pg_indexes where schemaname = ${schemaName}
        and indexname like 'public_media_%'
    `;
    expect(indexes.map((row) => row.indexname)).toEqual(expect.arrayContaining([
      "public_media_upload_intents_asset_uidx",
      "public_media_derivatives_asset_variant_uidx",
      "public_media_assets_owner_state_idx",
      "public_media_assets_cleanup_idx",
      "public_media_processing_attempts_worker_idx",
    ]));
  });

  test("advances migration journal from index 20/count 21 to index 21/count 22", async () => {
    const [entry] = await client.unsafe<{ id: number; hash: string }[]>(`select id, hash from "${journalSchema}"."__drizzle_migrations" order by id desc limit 1`);
    expect(entry?.id).toBe(22);
    const [count] = await client.unsafe<{ count: number }[]>(`select count(*)::int as count from "${journalSchema}"."__drizzle_migrations"`);
    expect(count?.count).toBe(22);
  });
});
