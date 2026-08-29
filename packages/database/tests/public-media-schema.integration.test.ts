import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
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
let client2: postgres.Sql;
let db: ReturnType<typeof drizzle>;

const at = "2026-08-29T12:00:00.000Z";
const later = "2026-08-29T12:15:00.000Z";

async function fixture(withIntent = true) {
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
  if (withIntent) await insertIntent(assetId, userId, intentId);
  return { userId, assetId, intentId };
}

async function completeIntent(f: { assetId: string; intentId: string }) {
  await client.unsafe(`update public_media_upload_intents set state = 'completed', completed_at = '${later}' where id = '${f.intentId}'`);
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

async function insertDerivative(
  assetId: string,
  variant: "master" | "thumb" | "display" | "large",
  byteSize = 100,
) {
  await db.insert(publicMediaDerivatives).values({
    id: randomUUID(),
    assetId,
    variant,
    format: "webp",
    width: variant === "thumb" ? 384 : variant === "display" ? 1280 : variant === "large" ? 2400 : 4096,
    height: 300,
    byteSize,
    contentHash: `sha256:v1:${"a".repeat(43)}`,
    objectKey: `derivatives/${assetId}/${variant}/hash.webp`,
    objectVersionId: `version-${variant}`,
    verifiedAt: new Date(at),
    createdAt: new Date(at),
    updatedAt: new Date(at),
  });
}

async function expectSqlState(
  operation: Promise<unknown>,
  code: string,
  reason: RegExp,
) {
  let error: unknown;
  try {
    await operation;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeDefined();
  expect((error as { code?: string }).code).toBe(code);
  expect(String(error)).toMatch(reason);
}

describe("public media persistence", () => {
  beforeAll(async () => {
    await admin.unsafe(`create schema "${schemaName}"`);
    client = postgres(databaseUrl, { max: 1 });
    await client.unsafe(`set search_path to "${schemaName}", public`);
    client2 = postgres(databaseUrl, { max: 1 });
    await client2.unsafe(`set search_path to "${schemaName}", public`);
    db = drizzle(client);
    await migrate(db, { migrationsFolder, migrationsSchema: journalSchema });
  });

  afterAll(async () => {
    await client.end();
    await client2.end();
    await admin.unsafe(`drop schema if exists "${schemaName}" cascade`);
    await admin.end();
  });

  test("exports all authoritative media tables and enforces one intent per asset and variant", async () => {
    const f = await fixture();
    await expect(insertIntent(f.assetId, f.userId)).rejects.toThrow();
    await insertDerivative(f.assetId, "thumb");
    await expect(insertDerivative(f.assetId, "thumb")).rejects.toThrow();
  });

  test("ready requires all four verified fixed derivatives", async () => {
    const f = await fixture();
    await completeIntent(f);
    await client.unsafe(`update public_media_assets set state = 'pending', source_object_version_id = 'source-v1', source_object_etag = 'etag-v1', actual_source_bytes = 512 where id = '${f.assetId}'`);
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
    await completeIntent(f);
    await client.unsafe(`update public_media_assets set state = 'pending', source_object_version_id = 'source-v1', source_object_etag = 'etag-v1', actual_source_bytes = 512 where id = '${f.assetId}'`);
    await client.unsafe(`update public_media_assets set state = 'failed', failure_code = 'failed_validation' where id = '${f.assetId}'`);
    await expect(client.unsafe(`update public_media_assets set state = 'pending' where id = '${f.assetId}'`)).rejects.toThrow();
  });

  test("allows only reviewed ready cleanup and freezes derivatives at terminal states", async () => {
    const f = await fixture();
    await completeIntent(f);
    await client.unsafe(`update public_media_assets set state = 'pending', source_object_version_id = 'source-v1', source_object_etag = 'etag-v1', actual_source_bytes = 512 where id = '${f.assetId}'`);
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

  test("binds every opaque object key to its owning asset, intent, and variant", async () => {
    const f = await fixture();
    const otherAssetId = randomUUID();
    await expect(client.unsafe(`update public_media_assets set source_object_key = 'quarantine/${otherAssetId}/${f.intentId}' where id = '${f.assetId}'`)).rejects.toThrow();
    await expect(client.unsafe(`update public_media_assets set source_object_key = 'quarantine/${f.assetId}/${randomUUID()}' where id = '${f.assetId}'`)).rejects.toThrow();
    await expect(client.unsafe(`update public_media_upload_intents set object_key = 'quarantine/${f.assetId}/${randomUUID()}' where id = '${f.intentId}'`)).rejects.toThrow();
    await insertDerivative(f.assetId, "thumb");
    await expect(client.unsafe(`update public_media_derivatives set object_key = 'derivatives/${otherAssetId}/thumb/hash.webp' where asset_id = '${f.assetId}'`)).rejects.toThrow();
    await expect(client.unsafe(`update public_media_derivatives set object_key = 'derivatives/${f.assetId}/display/hash.webp' where asset_id = '${f.assetId}'`)).rejects.toThrow();
  });

  test("enforces source pinning and allows validation failure before or after pinning", async () => {
    const prePin = await fixture();
    await client.unsafe(`update public_media_assets set state = 'failed', failure_code = 'failed_validation' where id = '${prePin.assetId}'`);

    const f = await fixture();
    await expect(client.unsafe(`update public_media_assets set state = 'pending' where id = '${f.assetId}'`)).rejects.toThrow();
    await completeIntent(f);
    await client.unsafe(`update public_media_assets set state = 'pending', source_object_version_id = 'source-v1', source_object_etag = 'etag-v1', actual_source_bytes = 512 where id = '${f.assetId}'`);
    await expect(client.unsafe(`update public_media_assets set actual_source_bytes = 1025 where id = '${f.assetId}'`)).rejects.toThrow();
    await client.unsafe(`update public_media_assets set state = 'processing' where id = '${f.assetId}'`);
    await client.unsafe(`update public_media_assets set state = 'failed', failure_code = 'malformed_image' where id = '${f.assetId}'`);
    await expect(client.unsafe(`update public_media_assets set state = 'pending' where id = '${f.assetId}'`)).rejects.toThrow();
    await expect(client.unsafe(`update public_media_assets set source_object_version_id = null where id = '${f.assetId}'`)).rejects.toThrow();
    await expect(client.unsafe(`update public_media_assets set source_object_version_id = '', source_object_etag = '' where id = '${f.assetId}'`)).rejects.toThrow();
  });

  test("enforces issued-only upload intent transitions and terminal immutability", async () => {
    const expired = await fixture();
    await client.unsafe(`update public_media_upload_intents set state = 'expired' where id = '${expired.intentId}'`);
    await expect(client.unsafe(`update public_media_upload_intents set state = 'issued' where id = '${expired.intentId}'`)).rejects.toThrow();
    await expect(client.unsafe(`delete from public_media_upload_intents where id = '${expired.intentId}'`)).rejects.toThrow();

    const completed = await fixture();
    await client.unsafe(`update public_media_upload_intents set state = 'completed', completed_at = '${later}' where id = '${completed.intentId}'`);
    await client.unsafe(`update public_media_upload_intents set state = 'completed', completed_at = '${later}' where id = '${completed.intentId}'`);
    await expect(client.unsafe(`update public_media_upload_intents set updated_at = '${later}' where id = '${completed.intentId}'`)).rejects.toThrow();
    await expect(client.unsafe(`delete from public_media_upload_intents where id = '${completed.intentId}'`)).rejects.toThrow();
  });

  test("requires a completed matching intent before consuming source bytes", async () => {
    const issued = await fixture();
    await expectSqlState(
      client.unsafe(`update public_media_assets set state = 'pending', source_object_version_id = 'source-v1', source_object_etag = 'etag-v1', actual_source_bytes = 512 where id = '${issued.assetId}'`),
      "23514",
      /completed|intent/i,
    );

    const expired = await fixture();
    await client.unsafe(`update public_media_upload_intents set state = 'expired' where id = '${expired.intentId}'`);
    await expectSqlState(
      client.unsafe(`update public_media_assets set state = 'pending', source_object_version_id = 'source-v1', source_object_etag = 'etag-v1', actual_source_bytes = 512 where id = '${expired.assetId}'`),
      "23514",
      /completed|intent/i,
    );

    const missing = await fixture(false);
    await expectSqlState(
      client.unsafe(`update public_media_assets set state = 'pending', source_object_version_id = 'source-v1', source_object_etag = 'etag-v1', actual_source_bytes = 512 where id = '${missing.assetId}'`),
      "23514",
      /intent/i,
    );

    const completed = await fixture();
    await completeIntent(completed);
    await client.unsafe(`update public_media_assets set state = 'pending', source_object_version_id = 'source-v1', source_object_etag = 'etag-v1', actual_source_bytes = 512 where id = '${completed.assetId}'`);
  });

  test("freezes the pinned source tuple while allowing legal processing progression", async () => {
    const f = await fixture();
    await completeIntent(f);
    await client.unsafe(`update public_media_assets set state = 'pending', source_object_version_id = 'source-v1', source_object_etag = 'etag-v1', actual_source_bytes = 512 where id = '${f.assetId}'`);
    await expect(client.unsafe(`update public_media_assets set source_object_version_id = 'source-v2' where id = '${f.assetId}'`)).rejects.toThrow();
    await expect(client.unsafe(`update public_media_assets set source_object_version_id = null, source_object_etag = null, actual_source_bytes = null where id = '${f.assetId}'`)).rejects.toThrow();
    await expect(client.unsafe(`update public_media_assets set actual_source_bytes = 511 where id = '${f.assetId}'`)).rejects.toThrow();
    await expect(client.unsafe(`update public_media_assets set source_object_key = 'quarantine/${f.assetId}/${randomUUID()}' where id = '${f.assetId}'`)).rejects.toThrow();
    await client.unsafe(`update public_media_assets set state = 'processing', updated_at = '${later}' where id = '${f.assetId}'`);
    await client.unsafe(`update public_media_assets set state = 'failed', failure_code = 'malformed_image', updated_at = '${later}' where id = '${f.assetId}'`);
    await expect(client.unsafe(`update public_media_assets set source_object_etag = 'etag-v2' where id = '${f.assetId}'`)).rejects.toThrow();
    await client.unsafe(`update public_media_assets set source_deleted_at = '${later}', updated_at = '${later}' where id = '${f.assetId}'`);
    await expect(client.unsafe(`update public_media_assets set source_deleted_at = null where id = '${f.assetId}'`)).rejects.toThrow();
  });

  test("uses parent-first locking for source-key races and rejects mismatches", async () => {
    const f = await fixture(false);
    const alternateIntentId = randomUUID();
    let releaseAsset!: () => void;
    const assetUpdate = client.begin(async (tx) => {
      await tx.unsafe(`select id from public_media_assets where id = '${f.assetId}' for update`);
      await tx.unsafe(`update public_media_assets set source_object_key = 'quarantine/${f.assetId}/${alternateIntentId}' where id = '${f.assetId}'`);
      await new Promise<void>((resolve) => { releaseAsset = resolve; });
    });
    while (!releaseAsset) await new Promise((resolve) => setTimeout(resolve, 1));

    let insertSettled = false;
    const intentInsert = client2.unsafe(`insert into public_media_upload_intents
      (id, asset_id, owner_user_id, purpose, declared_source_format, max_source_bytes, max_source_pixels, object_key, state, expires_at, completed_at, created_at, updated_at)
      values ('${f.intentId}', '${f.assetId}', '${f.userId}', 'showcase', 'jpeg', 10485760, 40000000,
        'quarantine/${f.assetId}/${f.intentId}', 'issued', '${later}', null, '${at}', '${at}')`)
      .then(() => { insertSettled = true; }, () => { insertSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(insertSettled).toBe(false);
    releaseAsset();
    await assetUpdate;
    await intentInsert;
    const [asset] = await client.unsafe<{ source_object_key: string }[]>(`select source_object_key from public_media_assets where id = '${f.assetId}'`);
    expect(asset?.source_object_key).toBe(`quarantine/${f.assetId}/${alternateIntentId}`);
    const [intentCount] = await client.unsafe<{ count: number }[]>(`select count(*)::int as count from public_media_upload_intents where asset_id = '${f.assetId}'`);
    expect(intentCount?.count).toBe(0);
  });

  test("allows only monotonic cleanup on ready and then freezes deleted evidence", async () => {
    const f = await fixture();
    await completeIntent(f);
    await client.unsafe(`update public_media_assets set state = 'pending', source_object_version_id = 'source-v1', source_object_etag = 'etag-v1', actual_source_bytes = 512 where id = '${f.assetId}'`);
    await client.unsafe(`update public_media_assets set state = 'processing' where id = '${f.assetId}'`);
    for (const variant of ["master", "thumb", "display", "large"] as const) await insertDerivative(f.assetId, variant);
    await client.unsafe(`update public_media_assets set state = 'ready', ready_at = '${at}', width = 4096, height = 300,
      normalized_master_object_key = 'derivatives/${f.assetId}/master/hash.webp', normalized_master_object_version_id = 'version-master'
      where id = '${f.assetId}'`);
    await client.unsafe(`update public_media_assets set source_deleted_at = '${later}', updated_at = '${later}' where id = '${f.assetId}'`);
    await expect(client.unsafe(`update public_media_assets set source_deleted_at = null where id = '${f.assetId}'`)).rejects.toThrow();
    await expect(client.unsafe(`update public_media_assets set actual_source_bytes = 511 where id = '${f.assetId}'`)).rejects.toThrow();
    await expect(client.unsafe(`update public_media_assets set ready_at = '${later}' where id = '${f.assetId}'`)).rejects.toThrow();
    await client.unsafe(`update public_media_assets set state = 'deleted', deletion_reviewed_at = '${later}' where id = '${f.assetId}'`);
    await expect(client.unsafe(`update public_media_assets set source_deleted_at = '${at}' where id = '${f.assetId}'`)).rejects.toThrow();
    await expect(client.unsafe(`update public_media_assets set failure_code = 'storage_error' where id = '${f.assetId}'`)).rejects.toThrow();
  });

  test("enforces per-variant byte caps at both boundaries", async () => {
    const caps = { master: 10 * 1024 * 1024, thumb: 512 * 1024, display: 3 * 1024 * 1024, large: 6 * 1024 * 1024 } as const;
    for (const variant of ["master", "thumb", "display", "large"] as const) {
      const lower = await fixture();
      await insertDerivative(lower.assetId, variant, caps[variant] - 1);
      const accepted = await fixture();
      await insertDerivative(accepted.assetId, variant, caps[variant]);
      const rejected = await fixture();
      await expect(insertDerivative(rejected.assetId, variant, caps[variant] + 1)).rejects.toThrow();
    }
  });

  test("readiness takes a parent lock and serializes delete-versus-ready races", async () => {
    const readyFirst = await fixture();
    await completeIntent(readyFirst);
    await client.unsafe(`update public_media_assets set state = 'pending', source_object_version_id = 'source-v1', source_object_etag = 'etag-v1', actual_source_bytes = 512 where id = '${readyFirst.assetId}'`);
    await client.unsafe(`update public_media_assets set state = 'processing' where id = '${readyFirst.assetId}'`);
    for (const variant of ["master", "thumb", "display", "large"] as const) await insertDerivative(readyFirst.assetId, variant);
    let releaseReady!: () => void;
    const readyTransaction = client.begin(async (tx) => {
      await tx.unsafe(`select id from public_media_assets where id = '${readyFirst.assetId}' for update`);
      await tx.unsafe(`update public_media_assets set state = 'ready', ready_at = '${at}', width = 4096, height = 300,
        normalized_master_object_key = 'derivatives/${readyFirst.assetId}/master/hash.webp', normalized_master_object_version_id = 'version-master'
        where id = '${readyFirst.assetId}'`);
      await new Promise<void>((resolve) => { releaseReady = resolve; });
    });
    while (!releaseReady) await new Promise((resolve) => setTimeout(resolve, 1));
    const blockedDelete = client2.unsafe(`delete from public_media_derivatives where asset_id = '${readyFirst.assetId}' and variant = 'thumb'`);
    const blockedDeleteResult = blockedDelete.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseReady();
    await readyTransaction;
    const deleteResult = await blockedDeleteResult;
    expect(deleteResult.ok).toBe(false);
    if (deleteResult.ok) throw new Error("delete unexpectedly succeeded");
    expect((deleteResult.error as { code?: string }).code).toBe("55000");
    expect(String(deleteResult.error)).toMatch(/readiness|terminal|mutate/i);

    const deleteFirst = await fixture();
    await completeIntent(deleteFirst);
    await insertDerivative(deleteFirst.assetId, "thumb");
    let releaseDelete!: () => void;
    const deleteTransaction = client2.begin(async (tx) => {
      await tx.unsafe(`select id from public_media_assets where id = '${deleteFirst.assetId}' for update`);
      await tx.unsafe(`delete from public_media_derivatives where asset_id = '${deleteFirst.assetId}' and variant = 'thumb'`);
      await new Promise<void>((resolve) => { releaseDelete = resolve; });
    });
    while (!releaseDelete) await new Promise((resolve) => setTimeout(resolve, 1));
    const blockedReady = client.unsafe(`update public_media_assets set state = 'pending', source_object_version_id = 'source-v1', source_object_etag = 'etag-v1', actual_source_bytes = 512 where id = '${deleteFirst.assetId}'`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseDelete();
    await deleteTransaction;
    await expect(blockedReady).resolves.toBeDefined();
    await client.unsafe(`update public_media_assets set state = 'processing' where id = '${deleteFirst.assetId}'`);
    await expectSqlState(client.unsafe(`update public_media_assets set state = 'ready', ready_at = '${at}', width = 4096, height = 300,
      normalized_master_object_key = 'derivatives/${deleteFirst.assetId}/master/hash.webp', normalized_master_object_version_id = 'version-master'
      where id = '${deleteFirst.assetId}'`), "23514", /require/i);
  });

  test("keeps the Drizzle snapshot chain linked to migration 0020", async () => {
    const snapshot20 = JSON.parse(await readFile(new URL("../migrations/meta/0020_snapshot.json", import.meta.url), "utf8")) as { id: string };
    const snapshot21 = JSON.parse(await readFile(new URL("../migrations/meta/0021_snapshot.json", import.meta.url), "utf8")) as { id: string; prevId: string };
    expect(snapshot21.prevId).toBe(snapshot20.id);
    const journal = JSON.parse(await readFile(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.at(-1)).toMatchObject({ idx: 21, tag: "0021_increment_3_public_media" });
    expect(journal.entries).toHaveLength(22);
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

  test("returns authoritative SQLSTATEs and rolls back partial media writes", async () => {
    const f = await fixture();
    await expectSqlState(
      client.unsafe(`update public_media_assets set state = 'processing' where id = '${f.assetId}'`),
      "23514",
      /awaiting_upload|transition/i,
    );
    await expectSqlState(
      client.unsafe(`insert into public_media_derivatives
        (id, asset_id, variant, format, width, height, byte_size, content_hash, object_key, object_version_id, verified_at, created_at, updated_at)
        values ('${randomUUID()}', '${f.assetId}', 'thumb', 'webp', 384, 300, 100,
          'sha256:v1:${"a".repeat(43)}', 'derivatives/${randomUUID()}/thumb/hash.webp', 'v1', '${at}', '${at}', '${at}')`),
      "23514",
      /bound|asset|variant/i,
    );

    const rollbackFixture = await fixture();
    await expect(client.begin(async (tx) => {
      await tx.unsafe(`insert into public_media_derivatives
        (id, asset_id, variant, format, width, height, byte_size, content_hash, object_key, object_version_id, verified_at, created_at, updated_at)
        values ('${randomUUID()}', '${rollbackFixture.assetId}', 'thumb', 'webp', 384, 300, 100,
          'sha256:v1:${"b".repeat(43)}', 'derivatives/${rollbackFixture.assetId}/thumb/hash.webp', 'v1', '${at}', '${at}', '${at}')`);
      throw new Error("intentional rollback");
    })).rejects.toThrow("intentional rollback");
    const [count] = await client.unsafe<{ count: number }[]>(
      `select count(*)::int as count from public_media_derivatives where asset_id = '${rollbackFixture.assetId}'`,
    );
    expect(count?.count).toBe(0);
  });

  test("advances migration journal from index 20/count 21 to index 21/count 22", async () => {
    const [entry] = await client.unsafe<{ id: number; hash: string }[]>(`select id, hash from "${journalSchema}"."__drizzle_migrations" order by id desc limit 1`);
    expect(entry?.id).toBe(22);
    const [count] = await client.unsafe<{ count: number }[]>(`select count(*)::int as count from "${journalSchema}"."__drizzle_migrations"`);
    expect(count?.count).toBe(22);
  });
});
