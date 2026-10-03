import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "@pawket/database";
import type { PawketDatabase } from "@pawket/database";
import { createEncryptionKeyring, encryptSensitiveField } from "@pawket/security";

export const fixtureAt = new Date("2026-10-01T03:00:00.000Z");
export const fixtureKeyring = createEncryptionKeyring({ activeKeyId: "i7-files-test", keys: { "i7-files-test": new Uint8Array(32).fill(73) } });
export const fixtureLookupKey = new Uint8Array(32).fill(74);
const envelope = <R extends string, F extends string>(recordType: R, recordId: string, fieldName: F, plaintext: string) =>
  encryptSensitiveField({ keyring: fixtureKeyring, plaintext, binding: { recordType, recordId, fieldName } });

export function createCommissionFileFixture(label: string) {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is required for commission file tests");
  const parsed = new URL(url);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || !/test|ci/iu.test(parsed.pathname)) throw new Error("Commission file tests require a dedicated local test database");
  const schemaName = `i7_files_${label}_${process.pid}_${Date.now()}`; const journalSchema = `${schemaName}_journal`;
  const client = postgres(url, { max: 4, connection: { search_path: `${schemaName},public` }, onnotice: () => undefined });
  const db = drizzle(client, { schema }) as unknown as PawketDatabase;

  async function initialize() {
    await client.unsafe(`create schema "${schemaName}"`);
    await migrate(db as never, { migrationsFolder: fileURLToPath(new URL("../../database/migrations/", import.meta.url)), migrationsSchema: journalSchema });
  }
  async function dispose() {
    await client.unsafe(`drop schema if exists "${schemaName}" cascade`);
    await client.unsafe(`drop schema if exists "${journalSchema}" cascade`);
    await client.end();
  }
  async function person() {
    const id = `i7-files-${randomUUID()}`;
    await db.insert(schema.identityUsers).values({ id, name: "Synthetic participant", email: `${id}@example.invalid`, canonicalEmail: `${id}@example.invalid`, createdAt: fixtureAt, updatedAt: fixtureAt });
    return id;
  }
  async function order() {
    const creatorUserId = await person(); const buyerUserId = await person();
    const pageId = randomUUID(); const packageId = randomUUID(); const packageRevisionId = randomUUID(); const orderId = randomUUID();
    await db.insert(schema.creatorPages).values({ id: pageId, userId: creatorUserId, initializedFromRevisionId: randomUUID(), createdAt: fixtureAt, updatedAt: fixtureAt });
    await db.insert(schema.commissionPackages).values({ id: packageId, creatorUserId, pageId, draft: { title: "Portrait", description: "Synthetic", discipline: "illustration",
      route: "custom_quote", briefInstructions: "Describe", terms: null, showcaseId: null }, createdAt: fixtureAt, updatedAt: fixtureAt });
    await db.insert(schema.commissionPackageRevisions).values({ id: packageRevisionId, packageId, creatorUserId, revisionNumber: 1, policyRevisionId: schema.COMMISSION_POLICY_BOOTSTRAP_ID,
      title: "Portrait", description: "Synthetic", discipline: "illustration", route: "custom_quote", briefInstructions: "Describe", terms: null,
      actorSessionId: "synthetic-creator", requestId: randomUUID(), publishedAt: fixtureAt });
    await db.update(schema.commissionPackages).set({ state: "open", version: 2, publishedRevisionId: packageRevisionId, updatedAt: fixtureAt }).where(eq(schema.commissionPackages.id, packageId));
    await db.transaction(async (tx) => {
      await tx.insert(schema.commissionOrders).values({ id: orderId, creatorUserId, buyerUserId, packageId, packageRevisionId, route: "custom_quote", state: "requested", version: 1,
        expiresAt: new Date(fixtureAt.getTime() + 7 * 86_400_000), createdAt: fixtureAt, updatedAt: fixtureAt });
      await tx.insert(schema.commissionBriefs).values({ orderId, textEnvelope: envelope("commission_briefs", orderId, "text", "Private brief"),
        linksEnvelope: envelope("commission_briefs", orderId, "links", "[]"), buyerSessionId: "synthetic-buyer", requestId: randomUUID(), createdAt: fixtureAt });
      await tx.insert(schema.commissionEvents).values({ id: randomUUID(), orderId, orderVersion: 1, type: "requested", actorUserId: buyerUserId, actorSessionId: "synthetic-buyer", requestId: randomUUID(), occurredAt: fixtureAt });
    });
    return { creatorUserId, buyerUserId, packageId, packageRevisionId, orderId };
  }
  async function closeOrder(orderId: string, buyerUserId: string, at = new Date(fixtureAt.getTime() + 60_000)) {
    await db.transaction(async (tx) => {
      await tx.update(schema.commissionOrders).set({ state: "closed", version: 2, closeReason: "buyer_withdrawn", closedAt: at, updatedAt: at }).where(eq(schema.commissionOrders.id, orderId));
      await tx.insert(schema.commissionEvents).values({ id: randomUUID(), orderId, orderVersion: 2, type: "closed", reason: "buyer_withdrawn", actorUserId: buyerUserId, actorSessionId: "synthetic-buyer", requestId: randomUUID(), occurredAt: at });
    });
  }
  async function file(input: Readonly<{ ownerUserId: string; packageId: string; state?: "awaiting_upload" | "scanning" | "clean"; declaredBytes?: number; at?: Date; name?: string; detectedType?: "jpeg" | "png" | "webp" | "gif" | "pdf" }>) {
    const id = randomUUID(); const at = input.at ?? fixtureAt; const state = input.state ?? "clean";
    await db.insert(schema.commissionFiles).values({ id, ownerUserId: input.ownerUserId, context: "brief", packageId: input.packageId, declaredBytes: input.declaredBytes ?? 16,
      filenameEnvelope: envelope("commission_files", id, "filename", input.name ?? "reference.png"), objectKey: `commission/${id}`,
      uploadExpiresAt: new Date(at.getTime() + 900_000), requestId: "fixture", createdAt: at, updatedAt: at });
    if (state === "awaiting_upload") return id;
    await db.update(schema.commissionFiles).set({ state: "scanning", uploadedAt: at, scanDeadlineAt: new Date(at.getTime() + 86_400_000), version: 2, updatedAt: at }).where(eq(schema.commissionFiles.id, id));
    if (state === "scanning") return id;
    await db.update(schema.commissionFiles).set({ state: "clean", sha256: `sha256:${"c".repeat(64)}`, detectedType: input.detectedType ?? "png", quarantineVersionId: "q-fixture",
      cleanVersionId: "c-fixture", cleanAt: at, version: 3, updatedAt: at }).where(eq(schema.commissionFiles.id, id));
    return id;
  }
  async function read(fileId: string) {
    const [row] = await db.select().from(schema.commissionFiles).where(eq(schema.commissionFiles.id, fileId));
    if (!row) throw new Error("Missing fixture file");
    return row;
  }
  async function attach(fileId: string, orderId: string, position = 0, at = fixtureAt) {
    const row = await read(fileId);
    await db.transaction(async (tx) => {
      await tx.update(schema.commissionFiles).set({ state: "attached", orderId, attachedAt: at, version: row.version + 1, updatedAt: at }).where(eq(schema.commissionFiles.id, fileId));
      await tx.insert(schema.commissionFileAttachments).values({ fileId, orderId, targetKind: "brief", targetId: orderId, position, attachedAt: at });
    });
  }
  return { db, initialize, dispose, person, order, closeOrder, file, attach, read };
}
