import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, expect, test } from "vitest";
import * as schema from "@pawket/database";
import { createEncryptionKeyring, encryptSensitiveField } from "@pawket/security";
import { createCommissionPolicyReadPort } from "@pawket/orders";
import { createCommissionPackageService } from "../src/commission-packages.js";
import type { CommissionPackageHoldPort } from "../src/catalog-ports.js";

const url = process.env.TEST_DATABASE_URL; if (!url) throw new Error("TEST_DATABASE_URL is required");
const parsed = new URL(url);
if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || !/test|ci/iu.test(parsed.pathname)) throw new Error("Package hides require a dedicated local test database");
const name = `package_hides_${process.pid}_${Date.now()}`; const journal = `${name}_journal`;
const client = postgres(url, { max: 4, connection: { search_path: `${name},public` }, onnotice: () => undefined });
const db = drizzle(client, { schema }); const at = new Date("2026-10-01T03:00:00Z");
beforeAll(async () => { await client.unsafe(`create schema "${name}"`); await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../database/migrations/", import.meta.url)), migrationsSchema: journal }); }, 60_000);
afterAll(async () => { await client.unsafe(`drop schema if exists "${name}" cascade`); await client.unsafe(`drop schema if exists "${journal}" cascade`); await client.end(); }, 30_000);

test("held packages disappear publicly, refuse old-revision intake, remain marked in workspace, and restore", async () => {
  const actor = { userId: randomUUID(), sessionId: "synthetic-session" }; const pageId = randomUUID(); const packageId = randomUUID(); const oldRevisionId = randomUUID();
  const revisionId = randomUUID(); const publicationId = randomUUID(); const handle = "synthetic-artist";
  await db.insert(schema.identityUsers).values({ id: actor.userId, name: "Synthetic", email: `${actor.userId}@example.invalid`, canonicalEmail: `${actor.userId}@example.invalid`, createdAt: at, updatedAt: at });
  await db.insert(schema.creatorPages).values({ id: pageId, userId: actor.userId, initializedFromRevisionId: randomUUID(), createdAt: at, updatedAt: at });
  await db.insert(schema.creatorPublicationRevisions).values({ id: publicationId, pageId, revisionNumber: 1, canonicalHandle: handle, displayName: "Synthetic", shortIntroduction: "Synthetic", primaryDiscipline: "illustration", secondaryDisciplines: [], actorUserId: actor.userId, actorSessionId: actor.sessionId, expectedDraftVersion: 1, requestId: randomUUID(), publishedAt: at });
  await db.update(schema.creatorPages).set({ publishedRevisionId: publicationId }).where(eq(schema.creatorPages.id, pageId));
  await db.insert(schema.creatorHandleClaims).values({ id: randomUUID(), pageId, normalizedHandle: handle, kind: "canonical", claimedAt: at });
  await db.insert(schema.creatorCommissionSettings).values({ creatorUserId: actor.userId, enabled: true, capacityLimit: 3, createdAt: at, updatedAt: at });
  const draft = { title: "Portrait", description: "Public description", discipline: "illustration", route: "custom_quote" as const, briefInstructions: "Describe", terms: null, showcaseId: null };
  await db.insert(schema.commissionPackages).values({ id: packageId, creatorUserId: actor.userId, pageId, draft, createdAt: at, updatedAt: at });
  for (const [index, id] of [oldRevisionId, revisionId].entries()) await db.insert(schema.commissionPackageRevisions).values({ id, packageId, creatorUserId: actor.userId, revisionNumber: index + 1,
    ...draft, policyRevisionId: schema.COMMISSION_POLICY_BOOTSTRAP_ID, actorSessionId: actor.sessionId, requestId: randomUUID(), publishedAt: at });
  await db.update(schema.commissionPackages).set({ state: "open", publishedRevisionId: revisionId, version: 2 }).where(eq(schema.commissionPackages.id, packageId));
  // Exercise Catalog's structural contract against actual active hide rows, without importing Trust.
  const caseId = randomUUID(); const reportId = randomUUID(); const hideId = randomUUID(); const keyring = createEncryptionKeyring({ activeKeyId: "test", keys: { test: new Uint8Array(32).fill(72) } });
  await db.transaction(async (tx) => {
    await tx.insert(schema.trustCases).values({ id: caseId, kind: "report", sourceType: "commission_package", sourceId: packageId, openedAt: at });
    await tx.insert(schema.trustCaseEvents).values({ id: randomUUID(), caseId, action: "opened", requestId: randomUUID(), expectedVersion: 0, resultingVersion: 1,
      beforeState: null, afterState: "open", occurredAt: at });
  });
  await db.insert(schema.trustReports).values({ id: reportId, caseId, targetKind: "commission_package", targetId: packageId, packageRevisionId: oldRevisionId,
    contentOwnerUserId: actor.userId, reporterNetworkHmac: `hmac-sha256:v1:${"a".repeat(43)}`, reportReference: `report:v2:${"a".repeat(32)}`, reason: "other", createdAt: at });
  const contentHides: CommissionPackageHoldPort = {
    hiddenIds: async (tx, kind, ids) => { const rows = await tx.select().from(schema.trustContentHides); return new Set(rows.filter((row) => row.targetKind === kind && row.releasedAt === null && ids.includes(row.targetId)).map((row) => row.targetId)); },
    activeHide: async (tx, kind, id) => { const rows = await tx.select().from(schema.trustContentHides); const row = rows.find((row) => row.targetKind === kind && row.targetId === id && row.releasedAt === null); return row ? { hideId: row.id, hiddenAt: row.hiddenAt } : null; },
  };
  const catalog = createCommissionPackageService({ db, applicationRevision: "synthetic-hide", lookupHmacKey: new Uint8Array(32).fill(73), intakeMode: "enabled", paymentsMode: "manual_only", publishingMode: "general_audience",
    contentHides, policy: createCommissionPolicyReadPort({ environment: "test" }), identity: { lockCreator: async () => ({ sessionExpiresAt: new Date(at.getTime() + 60_000) }) },
    receivingAccount: { getCurrentTipReceivingAccount: async () => null }, now: () => at,
    visibility: { resolveVisibleReportTarget: async (_tx, target) => ({ target, pageId, creatorUserId: actor.userId, canonicalHandle: handle, displayName: "Artist", showcaseTitle: null, mediaAssetIds: [] }) } });
  expect(await catalog.listPublic(handle)).toHaveLength(1);
  await db.insert(schema.trustContentHides).values({ id: hideId, caseId, targetKind: "commission_package", targetId: packageId, contentOwnerUserId: actor.userId,
    hiddenAt: at, hiddenByUserId: actor.userId, hiddenBySessionId: actor.sessionId, requestId: randomUUID(),
    reasonEnvelope: encryptSensitiveField({ keyring, plaintext: "Private reason", binding: { recordType: "trust_content_hides", recordId: hideId, fieldName: "reason" } }) });
  expect(await catalog.listPublic(handle)).toEqual([]);
  expect((await catalog.getWorkspace(actor)).packages[0]).toMatchObject({ id: packageId, hidden: true });
  await expect(db.transaction((tx) => catalog.getIntakePackage(tx, { packageId, revisionId: oldRevisionId, allowPreviousRevision: true, at }))).rejects.toMatchObject({ code: "not_available" });
  expect(await db.transaction((tx) => catalog.readRevisionForCase(tx, oldRevisionId))).toMatchObject({ id: oldRevisionId, title: "Portrait", hidden: true });
  await db.update(schema.trustContentHides).set({ releasedAt: at, releasedByUserId: actor.userId, releaseKind: "owner_restore", releaseRequestId: randomUUID() }).where(eq(schema.trustContentHides.id, hideId));
  expect(await catalog.listPublic(handle)).toHaveLength(1); expect((await catalog.getWorkspace(actor)).packages[0]!.hidden).toBe(false);
}, 30_000);
