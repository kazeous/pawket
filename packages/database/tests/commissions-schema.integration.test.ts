import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createEncryptionKeyring, encryptSensitiveField } from "@pawket/security";
import * as schema from "../src/schema.js";
import {
  COMMISSION_POLICY_BOOTSTRAP_ID, commissionAcceptances, commissionBriefs, commissionEvents,
  commissionOrders, commissionPackageRevisions, commissionPackages, commissionPolicyRevisions,
  commissionQuoteRevisions, creatorPages, identityUsers,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for commission schema tests");
const parsed = new URL(databaseUrl);
if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || !/test|ci/iu.test(parsed.pathname)) {
  throw new Error("Commission schema tests require a dedicated local test database");
}
const schemaName = `commission_schema_${process.pid}_${Date.now()}`;
const journalSchema = `${schemaName}_journal`;
const client = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
const db = drizzle(client, { schema });
const migrationsFolder = fileURLToPath(new URL("../migrations/", import.meta.url));
const at = new Date("2026-09-25T01:00:00Z");
const later = new Date("2026-09-25T02:00:00Z");
const expiry = new Date("2026-10-02T01:00:00Z");
const keyring = createEncryptionKeyring({ activeKeyId: "i6-schema-synthetic", keys: { "i6-schema-synthetic": new Uint8Array(32).fill(61) } });
const envelope = <R extends string, F extends string>(recordType: R, recordId: string, fieldName: F, plaintext: string) =>
  encryptSensitiveField({ keyring, plaintext, binding: { recordType, recordId, fieldName } });

async function expectSqlState(operation: PromiseLike<unknown>, code: string) {
  try { await operation; } catch (error) {
    expect((error as { cause?: unknown }).cause ?? error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected SQLSTATE ${code}`);
}
async function person() {
  const id = `i6-schema-${randomUUID()}`;
  await db.insert(identityUsers).values({ id, name: "Synthetic commission participant", email: `${id}@example.invalid`, canonicalEmail: `${id}@example.invalid`, createdAt: at, updatedAt: at });
  return id;
}
async function packageFixture(route: "custom_quote" | "fixed_approval" = "custom_quote") {
  const creatorUserId = await person(); const buyerUserId = await person();
  const pageId = randomUUID(); const packageId = randomUUID(); const packageRevisionId = randomUUID();
  await db.insert(creatorPages).values({ id: pageId, userId: creatorUserId, initializedFromRevisionId: randomUUID(), createdAt: at, updatedAt: at });
  const terms = route === "custom_quote" ? null : { amountVnd: 500_000, turnaroundDays: 7, revisionAllowance: 2, reviewWindowDays: 7,
    scope: "One portrait", deliverables: "PNG", usageRights: "Personal use", artistTerms: "Original terms", policyRevisionId: COMMISSION_POLICY_BOOTSTRAP_ID };
  await db.insert(commissionPackages).values({ id: packageId, creatorUserId, pageId, draft: { title: "Portrait", description: "Synthetic package", discipline: "illustration", route, briefInstructions: "Describe the portrait", terms, showcaseId: null }, createdAt: at, updatedAt: at });
  await db.insert(commissionPackageRevisions).values({ id: packageRevisionId, packageId, creatorUserId, revisionNumber: 1, policyRevisionId: COMMISSION_POLICY_BOOTSTRAP_ID,
    title: "Portrait", description: "Synthetic package", discipline: "illustration", route, briefInstructions: "Describe the portrait", terms, actorSessionId: "synthetic-creator", requestId: randomUUID(), publishedAt: at });
  await db.update(commissionPackages).set({ state: "open", version: 2, publishedRevisionId: packageRevisionId, updatedAt: at }).where(eq(commissionPackages.id, packageId));
  return { creatorUserId, buyerUserId, pageId, packageId, packageRevisionId, route };
}
async function requestFixture(f?: Awaited<ReturnType<typeof packageFixture>>) {
  f ??= await packageFixture();
  const id = randomUUID();
  const order = { id, creatorUserId: f.creatorUserId, buyerUserId: f.buyerUserId, packageId: f.packageId, packageRevisionId: f.packageRevisionId,
    route: f.route, state: "requested", version: 1, expiresAt: expiry, createdAt: at, updatedAt: at };
  await db.transaction(async (tx) => {
    await tx.insert(commissionOrders).values(order);
    await tx.insert(commissionBriefs).values({ orderId: id, textEnvelope: envelope("commission_briefs", id, "text", "Private portrait brief"),
      linksEnvelope: envelope("commission_briefs", id, "links", "[]"), buyerSessionId: "synthetic-buyer", requestId: randomUUID(), createdAt: at });
    await tx.insert(commissionEvents).values({ id: randomUUID(), orderId: id, orderVersion: 1, type: "requested", actorUserId: f.buyerUserId, actorSessionId: "synthetic-buyer", requestId: randomUUID(), occurredAt: at });
    if (f.route !== "custom_quote") await tx.insert(commissionAcceptances).values({ id: randomUUID(), orderId: id, actorUserId: f.buyerUserId, actorSessionId: "synthetic-buyer",
      role: "buyer", packageRevisionId: f.packageRevisionId, policyRevisionId: COMMISSION_POLICY_BOOTSTRAP_ID, requestId: randomUUID(), acceptedAt: at });
  });
  return { ...f, order };
}
async function quoteFixture() {
  const f = await requestFixture(); const id = randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(commissionQuoteRevisions).values({ id, orderId: f.order.id, revisionNumber: 1, policyRevisionId: COMMISSION_POLICY_BOOTSTRAP_ID,
      amountVnd: 600_000, turnaroundDays: 7, revisionAllowance: 2, reviewWindowDays: 7,
      scopeEnvelope: envelope("commission_quote_revisions", id, "scope", "Scope"), deliverablesEnvelope: envelope("commission_quote_revisions", id, "deliverables", "PNG"),
      usageRightsEnvelope: envelope("commission_quote_revisions", id, "usage_rights", "Personal"), artistTermsEnvelope: envelope("commission_quote_revisions", id, "artist_terms", "Original terms"),
      actorSessionId: "synthetic-creator", requestId: randomUUID(), issuedAt: later, expiresAt: expiry });
    await tx.update(commissionOrders).set({ state: "quoted", version: 2, currentQuoteId: id, updatedAt: later }).where(eq(commissionOrders.id, f.order.id));
    await tx.insert(commissionEvents).values({ id: randomUUID(), orderId: f.order.id, orderVersion: 2, type: "quoted", actorUserId: f.creatorUserId, actorSessionId: "synthetic-creator", requestId: randomUUID(), occurredAt: later });
  });
  return { ...f, quoteId: id };
}

beforeAll(async () => {
  await client.unsafe(`create schema "${schemaName}"`);
  await client.unsafe(`set search_path to "${schemaName}", public`);
  await migrate(db, { migrationsFolder, migrationsSchema: journalSchema });
}, 30_000);
afterAll(async () => {
  await client.unsafe("set search_path to public");
  await client.unsafe(`drop schema if exists "${schemaName}" cascade`);
  await client.unsafe(`drop schema if exists "${journalSchema}" cascade`);
  await client.end();
});

describe("commission schema commitments", () => {
  test("migrates the real journal twice and never fabricates live policy approval", async () => {
    await migrate(db, { migrationsFolder, migrationsSchema: journalSchema });
    const [policy] = await db.select().from(commissionPolicyRevisions).where(eq(commissionPolicyRevisions.id, COMMISSION_POLICY_BOOTSTRAP_ID));
    expect(policy).toMatchObject({ minimumVnd: 50_000, maximumVnd: 50_000_000, approvalKind: "technical_only", document: null, actorUserId: null });
    const foreignSchemas = await client`select distinct target_ns.nspname from pg_constraint c join pg_class source on source.oid = c.conrelid join pg_namespace source_ns on source_ns.oid = source.relnamespace join pg_class target on target.oid = c.confrelid join pg_namespace target_ns on target_ns.oid = target.relnamespace where c.contype = 'f' and source_ns.nspname = ${schemaName}`;
    expect(foreignSchemas).toEqual([{ nspname: schemaName }]);
  });
  test("a request and encrypted brief commit together with transition evidence", async () => {
    const f = await requestFixture();
    const [brief] = await db.select().from(commissionBriefs).where(eq(commissionBriefs.orderId, f.order.id));
    expect(JSON.stringify(brief)).not.toContain("Private portrait brief");
    await expectSqlState(db.insert(commissionOrders).values({ ...f.order, id: randomUUID() }), "23514");
    await expectSqlState(db.delete(commissionBriefs).where(eq(commissionBriefs.orderId, f.order.id)), "23514");
  });
  test("fixed requests retain their original immutable package and buyer acceptance", async () => {
    const f = await requestFixture(await packageFixture("fixed_approval"));
    await expectSqlState(db.update(commissionPackageRevisions).set({ title: "Rewritten terms" }).where(eq(commissionPackageRevisions.id, f.packageRevisionId)), "23514");
    await expectSqlState(db.update(commissionAcceptances).set({ policyRevisionId: randomUUID() }).where(eq(commissionAcceptances.orderId, f.order.id)), "23514");
    await expectSqlState(db.update(commissionOrders).set({ buyerUserId: f.creatorUserId, version: 2, updatedAt: later }).where(eq(commissionOrders.id, f.order.id)), "23514");
  });
  test("quote history cannot be overwritten, moved across orders, or accepted without the commitment graph", async () => {
    const f = await quoteFixture();
    await expectSqlState(db.update(commissionQuoteRevisions).set({ amountVnd: 700_000 }).where(eq(commissionQuoteRevisions.id, f.quoteId)), "23514");
    await expectSqlState(db.transaction(async (tx) => {
      await tx.update(commissionOrders).set({ state: "awaiting_payment", version: 3, amountVnd: 600_000, acceptedAt: later, expiresAt: new Date(later.getTime() + 86_400_000), updatedAt: later }).where(eq(commissionOrders.id, f.order.id));
      await tx.insert(commissionEvents).values({ id: randomUUID(), orderId: f.order.id, orderVersion: 3, type: "awaiting_payment", actorUserId: f.buyerUserId, requestId: randomUUID(), occurredAt: later });
    }), "23514");
    const [order] = await db.select().from(commissionOrders).where(eq(commissionOrders.id, f.order.id));
    expect(order).toMatchObject({ state: "quoted", version: 2, amountVnd: null });
  });
  test("closed requests do not reopen and terminal reasons match the previous state", async () => {
    const f = await requestFixture();
    await expectSqlState(db.update(commissionOrders).set({ state: "closed", version: 2, closeReason: "payment_expired", closedAt: later, updatedAt: later }).where(eq(commissionOrders.id, f.order.id)), "23514");
    await db.transaction(async (tx) => {
      await tx.update(commissionOrders).set({ state: "closed", version: 2, closeReason: "buyer_withdrawn", closedAt: later, updatedAt: later }).where(eq(commissionOrders.id, f.order.id));
      await tx.insert(commissionEvents).values({ id: randomUUID(), orderId: f.order.id, orderVersion: 2, type: "closed", reason: "buyer_withdrawn", actorUserId: f.buyerUserId, actorSessionId: "synthetic-buyer", requestId: randomUUID(), occurredAt: later });
    });
    await expectSqlState(db.update(commissionOrders).set({ state: "requested", version: 3, closeReason: null, closedAt: null, updatedAt: later }).where(eq(commissionOrders.id, f.order.id)), "23514");
  });
  test("a buyer cannot create more than three open requests to the same creator", async () => {
    const f = await packageFixture();
    await requestFixture(f); await requestFixture(f); await requestFixture(f);
    await expectSqlState(requestFixture(f), "23514");
  });
});
