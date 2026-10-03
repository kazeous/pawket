import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createEncryptionKeyring, encryptSensitiveField } from "@pawket/security";
import * as schema from "../src/schema.js";
import {
  COMMISSION_POLICY_BOOTSTRAP_ID, commissionBriefs, commissionEvents, commissionFileAttachments, commissionFiles,
  commissionOrders, commissionPackageRevisions, commissionPackages, creatorPages, identityUsers,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for commission file schema tests");
const parsedUrl = new URL(databaseUrl);
if (!["localhost", "127.0.0.1", "[::1]"].includes(parsedUrl.hostname) || !/test|ci/iu.test(parsedUrl.pathname)) {
  throw new Error("Commission file schema tests require a dedicated local test database");
}
const schemaName = `commission_files_schema_${process.pid}_${Date.now()}`;
const journalSchema = `${schemaName}_journal`;
const client = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
const db = drizzle(client, { schema });
const migrationsFolder = fileURLToPath(new URL("../migrations/", import.meta.url));
const at = new Date("2026-10-01T01:00:00Z");
const later = new Date("2026-10-01T01:05:00Z");
const expiry = new Date("2026-10-08T01:00:00Z");
const keyring = createEncryptionKeyring({ activeKeyId: "i7-schema-synthetic", keys: { "i7-schema-synthetic": new Uint8Array(32).fill(71) } });
const envelope = <R extends string, F extends string>(recordType: R, recordId: string, fieldName: F, plaintext: string) =>
  encryptSensitiveField({ keyring, plaintext, binding: { recordType, recordId, fieldName } });
const filename = (fileId: string) => envelope("commission_files", fileId, "filename", "ref.png");
const sha = `sha256:${"a".repeat(64)}`;
const legacyIds: string[] = [];

async function expectSqlState(operation: PromiseLike<unknown>, code: string) {
  try { await operation; } catch (error) {
    expect((error as { cause?: unknown }).cause ?? error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected SQLSTATE ${code}`);
}
async function person() {
  const id = `i7-schema-${randomUUID()}`;
  await db.insert(identityUsers).values({ id, name: "Synthetic participant", email: `${id}@example.invalid`, canonicalEmail: `${id}@example.invalid`, createdAt: at, updatedAt: at });
  return id;
}
async function orderFixture() {
  const creatorUserId = await person(); const buyerUserId = await person();
  const pageId = randomUUID(); const packageId = randomUUID(); const packageRevisionId = randomUUID(); const orderId = randomUUID();
  await db.insert(creatorPages).values({ id: pageId, userId: creatorUserId, initializedFromRevisionId: randomUUID(), createdAt: at, updatedAt: at });
  await db.insert(commissionPackages).values({ id: packageId, creatorUserId, pageId, draft: { title: "Portrait", description: "Synthetic package", discipline: "illustration",
    route: "custom_quote", briefInstructions: "Describe the portrait", terms: null, showcaseId: null }, createdAt: at, updatedAt: at });
  await db.insert(commissionPackageRevisions).values({ id: packageRevisionId, packageId, creatorUserId, revisionNumber: 1, policyRevisionId: COMMISSION_POLICY_BOOTSTRAP_ID,
    title: "Portrait", description: "Synthetic package", discipline: "illustration", route: "custom_quote", briefInstructions: "Describe the portrait", terms: null,
    actorSessionId: "synthetic-creator", requestId: randomUUID(), publishedAt: at });
  await db.update(commissionPackages).set({ state: "open", version: 2, publishedRevisionId: packageRevisionId, updatedAt: at }).where(eq(commissionPackages.id, packageId));
  await db.transaction(async (tx) => {
    await tx.insert(commissionOrders).values({ id: orderId, creatorUserId, buyerUserId, packageId, packageRevisionId, route: "custom_quote", state: "requested", version: 1,
      expiresAt: expiry, createdAt: at, updatedAt: at });
    await tx.insert(commissionBriefs).values({ orderId, textEnvelope: envelope("commission_briefs", orderId, "text", "Private brief"),
      linksEnvelope: envelope("commission_briefs", orderId, "links", "[]"), buyerSessionId: "synthetic-buyer", requestId: randomUUID(), createdAt: at });
    await tx.insert(commissionEvents).values({ id: randomUUID(), orderId, orderVersion: 1, type: "requested", actorUserId: buyerUserId, actorSessionId: "synthetic-buyer", requestId: randomUUID(), occurredAt: at });
  });
  return { creatorUserId, buyerUserId, packageId, orderId };
}

beforeAll(async () => {
  await client.unsafe(`create schema "${schemaName}"`);
  await client.unsafe(`set search_path to "${schemaName}", public`);
  // Exercise a real 0037 -> 0038 upgrade, including old completed purge facts.
  const oldFolder = await mkdtemp(join(tmpdir(), "pawket-i7-migrations-"));
  try {
    const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 37);
    await mkdir(join(oldFolder, "meta"));
    await writeFile(join(oldFolder, "meta/_journal.json"), JSON.stringify(journal));
    await Promise.all(journal.entries.map((entry) => copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(oldFolder, `${entry.tag}.sql`))));
    await migrate(db, { migrationsFolder: oldFolder, migrationsSchema: journalSchema });
    const owner = await orderFixture();
    for (const state of ["rejected", "scan_failed", "expired", "discarded"] as const) {
      const id = randomUUID(); legacyIds.push(id);
      await client`insert into commission_files (id, owner_user_id, context, package_id, declared_bytes, filename_envelope, object_key, upload_expires_at, request_id, created_at, updated_at)
        values (${id}, ${owner.buyerUserId}, 'brief', ${owner.packageId}, 3, ${JSON.stringify(filename(id))}::jsonb, ${`commission/${id}`}, ${new Date(at.getTime() + 900_000).toISOString()}, 'legacy', ${at.toISOString()}, ${at.toISOString()})`;
      if (state !== "expired") await client`update commission_files set state='scanning', uploaded_at=${at.toISOString()}, scan_deadline_at=${new Date(at.getTime() + 86_400_000).toISOString()}, version=version+1 where id=${id}`;
      await client`update commission_files set state=${state}, ended_at=${later.toISOString()}, rejection_reason=${state === "rejected" ? "size_mismatch" : null}, version=version+1 where id=${id}`;
      await client`update commission_files set clean_purged_at=${later.toISOString()}, quarantine_purged_at=${later.toISOString()}, version=version+1 where id=${id}`;
    }
  } finally { await rm(oldFolder, { recursive: true, force: true }); }
  await migrate(db, { migrationsFolder, migrationsSchema: journalSchema });
}, 60_000);
afterAll(async () => {
  await client.unsafe("set search_path to public");
  await client.unsafe(`drop schema if exists "${schemaName}" cascade`);
  await client.unsafe(`drop schema if exists "${journalSchema}" cascade`);
  await client.end();
});

async function newFile(ownerUserId: string, packageId: string) {
  const id = randomUUID();
  await db.insert(commissionFiles).values({ id, ownerUserId, context: "brief", packageId, declaredBytes: 3, filenameEnvelope: filename(id),
    objectKey: `commission/${id}`, uploadExpiresAt: new Date(at.getTime() + 15 * 60_000), requestId: "req-1", createdAt: at, updatedAt: at });
  return id;
}
async function step(id: string, values: Partial<typeof commissionFiles.$inferInsert>) {
  const [row] = await db.select().from(commissionFiles).where(eq(commissionFiles.id, id));
  await db.update(commissionFiles).set({ ...values, version: row!.version + 1, updatedAt: later }).where(eq(commissionFiles.id, id));
}
const uploaded = { state: "scanning", uploadedAt: at, scanDeadlineAt: new Date(at.getTime() + 86_400_000) } as const;
const clean = { state: "clean", sha256: sha, detectedType: "png", cleanVersionId: "v1", cleanAt: later, quarantineVersionId: "q1" } as const;

describe("commission file schema", () => {
  test("backfills ended legacy names and reopens ambiguous uploaded cleanup", async () => {
    for (const id of legacyIds) {
      const [row] = await db.select().from(commissionFiles).where(eq(commissionFiles.id, id));
      expect(row!.filenameEnvelope).toBeNull();
      expect(row!.cleanCopyIntent).toBe(row!.uploadedAt !== null);
      expect(row!.cleanPurgedAt === null).toBe(row!.uploadedAt !== null);
      await expectSqlState(step(id, { filenameEnvelope: filename(id) }), "23514");
    }
  });
  test.each(["rejected", "scan_failed", "expired", "discarded"] as const)("redacts %s automatically and refuses restoration or live name edits", async (state) => {
    const o = await orderFixture(); const id = await newFile(o.buyerUserId, o.packageId);
    await expectSqlState(step(id, { filenameEnvelope: filename(id) }), "23514");
    await expectSqlState(step(id, { filenameEnvelope: null }), "23514");
    if (state !== "expired") await step(id, uploaded);
    await step(id, { state, endedAt: later, ...(state === "rejected" ? { rejectionReason: "size_mismatch" } : {}) });
    const [row] = await db.select().from(commissionFiles).where(eq(commissionFiles.id, id));
    expect(row!.filenameEnvelope).toBeNull();
    await expectSqlState(step(id, { filenameEnvelope: filename(id) }), "23514");
    await expectSqlState(step(id, { state: "scanning" }), "23514");
  });
  test("copy intent is irreversible and cannot receive a final clean purge stamp", async () => {
    const o = await orderFixture(); const id = await newFile(o.buyerUserId, o.packageId);
    await expectSqlState(step(id, { cleanCopyIntent: true }), "23514");
    await step(id, uploaded); await step(id, { cleanCopyIntent: true });
    await expectSqlState(step(id, { cleanCopyIntent: false }), "23514");
    await step(id, { state: "discarded", endedAt: later });
    await expectSqlState(step(id, { cleanPurgedAt: later }), "23514");
  });
  test("follows the allowed lifecycle and attaches to the buyer's order", async () => {
    const { buyerUserId, packageId, orderId } = await orderFixture();
    const id = await newFile(buyerUserId, packageId);
    await step(id, uploaded); await step(id, clean);
    await db.transaction(async (tx) => {
      await tx.update(commissionFiles).set({ state: "attached", orderId, attachedAt: later, version: 4, updatedAt: later }).where(eq(commissionFiles.id, id));
      await tx.insert(commissionFileAttachments).values({ fileId: id, orderId, targetKind: "brief", targetId: orderId, position: 0, attachedAt: later });
    });
    const [row] = await db.select().from(commissionFiles).where(eq(commissionFiles.id, id));
    expect(row).toMatchObject({ state: "attached", orderId, sha256: sha });
  });
  test("rejects skipping the scan, reverting evidence, deleting rows and editing attachments", async () => {
    const { buyerUserId, packageId, orderId } = await orderFixture();
    const id = await newFile(buyerUserId, packageId);
    await expectSqlState(step(id, { ...clean, uploadedAt: at, scanDeadlineAt: new Date(at.getTime() + 86_400_000) }), "23514");
    await step(id, uploaded); await step(id, clean);
    await expectSqlState(step(id, { sha256: `sha256:${"b".repeat(64)}` }), "23514");
    await expectSqlState(db.delete(commissionFiles).where(eq(commissionFiles.id, id)), "23514");
    await db.transaction(async (tx) => {
      await tx.update(commissionFiles).set({ state: "attached", orderId, attachedAt: later, version: 4, updatedAt: later }).where(eq(commissionFiles.id, id));
      await tx.insert(commissionFileAttachments).values({ fileId: id, orderId, targetKind: "brief", targetId: orderId, position: 0, attachedAt: later });
    });
    await expectSqlState(db.update(commissionFileAttachments).set({ position: 1 }).where(eq(commissionFileAttachments.fileId, id)), "23514");
  });
  test("refuses attaching another person's file or a file uploaded for another package", async () => {
    const first = await orderFixture(); const second = await orderFixture();
    const foreign = await newFile(second.buyerUserId, second.packageId);
    await step(foreign, uploaded); await step(foreign, clean);
    await expectSqlState(db.transaction(async (tx) => {
      await tx.update(commissionFiles).set({ state: "attached", orderId: first.orderId, attachedAt: later, version: 4, updatedAt: later }).where(eq(commissionFiles.id, foreign));
      await tx.insert(commissionFileAttachments).values({ fileId: foreign, orderId: first.orderId, targetKind: "brief", targetId: first.orderId, position: 0, attachedAt: later });
    }), "23514");
  });
  test("requires a signature only for malware and bounds the declared size", async () => {
    const { buyerUserId, packageId } = await orderFixture();
    const id = await newFile(buyerUserId, packageId);
    await step(id, uploaded);
    await expectSqlState(step(id, { state: "rejected", rejectionReason: "malware", endedAt: later }), "23514");
    await step(id, { state: "rejected", rejectionReason: "malware", malwareSignature: "Eicar-Signature", endedAt: later });
    const big = randomUUID();
    await expectSqlState(db.insert(commissionFiles).values({ id: big, ownerUserId: buyerUserId, context: "brief", packageId, declaredBytes: 26_214_401, filenameEnvelope: filename(big),
      objectKey: `commission/${big}`, uploadExpiresAt: new Date(at.getTime() + 15 * 60_000), requestId: "req-2", createdAt: at, updatedAt: at }), "23514");
  });
});
