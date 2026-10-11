import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "@pawket/database";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { commissionPackages, creatorPages } from "@pawket/database";
import { createPackageReportTargetPort } from "../src/package-report-target.js";
const url = process.env.TEST_DATABASE_URL; if (!url) throw new Error("TEST_DATABASE_URL is required");
const parsed = new URL(url);
if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || !/test|ci/iu.test(parsed.pathname)) throw new Error("Package reports require a dedicated local test database");
const name = `package_reports_${process.pid}_${Date.now()}`; const journal = `${name}_journal`;
const client = postgres(url, { max: 4, connection: { search_path: `${name},public` }, onnotice: () => undefined });
const fixture = { db: drizzle(client, { schema }) }; const at = new Date("2026-10-01T03:00:00Z");
beforeAll(async () => { await client.unsafe(`create schema "${name}"`); await migrate(fixture.db, { migrationsFolder: fileURLToPath(new URL("../../database/migrations/", import.meta.url)), migrationsSchema: journal }); }, 60_000);
afterAll(async () => { await client.unsafe(`drop schema if exists "${name}" cascade`); await client.unsafe(`drop schema if exists "${journal}" cascade`); await client.end(); });
async function publicPackage() {
  const creatorUserId = randomUUID(); const buyerUserId = randomUUID(); const pageId = randomUUID(); const packageId = randomUUID(); const packageRevisionId = randomUUID(); const publicationId = randomUUID();
  for (const id of [creatorUserId, buyerUserId]) await fixture.db.insert(schema.identityUsers).values({ id, name: "Synthetic", email: `${id}@example.invalid`, canonicalEmail: `${id}@example.invalid`, createdAt: at, updatedAt: at });
  await fixture.db.insert(schema.creatorPages).values({ id: pageId, userId: creatorUserId, initializedFromRevisionId: randomUUID(), createdAt: at, updatedAt: at });
  const draft = { title: "Synthetic", description: "Synthetic", discipline: "illustration", route: "custom_quote" as const, briefInstructions: "Describe", terms: null, showcaseId: null };
  await fixture.db.insert(schema.commissionPackages).values({ id: packageId, creatorUserId, pageId, draft, createdAt: at, updatedAt: at });
  await fixture.db.insert(schema.commissionPackageRevisions).values({ id: packageRevisionId, packageId, creatorUserId, revisionNumber: 1, ...draft, policyRevisionId: schema.COMMISSION_POLICY_BOOTSTRAP_ID, actorSessionId: "synthetic", requestId: randomUUID(), publishedAt: at });
  await fixture.db.update(schema.commissionPackages).set({ state: "open", publishedRevisionId: packageRevisionId, version: 2 }).where(eq(schema.commissionPackages.id, packageId));
  await fixture.db.insert(schema.creatorPublicationRevisions).values({ id: publicationId, pageId, revisionNumber: 1, canonicalHandle: "synthetic-artist", displayName: "Synthetic", shortIntroduction: "Synthetic", primaryDiscipline: "illustration", secondaryDisciplines: [], actorUserId: creatorUserId, actorSessionId: "synthetic", expectedDraftVersion: 1, requestId: randomUUID(), publishedAt: at });
  await fixture.db.update(schema.creatorPages).set({ publishedRevisionId: publicationId }).where(eq(schema.creatorPages.id, pageId));
  return { pageId, packageId, packageRevisionId, publicationId, creator: { userId: creatorUserId }, buyer: { userId: buyerUserId } };
}
test("only the current open/paused public revision is reportable, excluding its owner", async () => {
  const p = await publicPackage(); const publicationId = p.publicationId;
  // A structural visibility provider stands in for the independently tested public catalog.
  const visibility = { resolveVisibleReportTarget: vi.fn(async () => ({ pageId: p.pageId, creatorUserId: p.creator.userId,
    target: { targetType: "page" as const, targetId: p.pageId, publicationRevisionId: publicationId }, canonicalHandle: "synthetic", displayName: "Synthetic", showcaseTitle: null, mediaAssetIds: [] })) };
  const port = createPackageReportTargetPort({ intakeMode: "enabled", publishingMode: "general_audience", visibility });
  const target = { kind: "commission_package" as const, packageId: p.packageId, revisionId: p.packageRevisionId };
  expect(await fixture.db.transaction((tx) => port.resolve(tx, target, null))).toEqual({ kind: "commission_package", targetId: p.packageId, orderId: null, contentOwnerUserId: p.creator.userId, packageRevisionId: p.packageRevisionId });
  expect(await fixture.db.transaction((tx) => port.resolve(tx, target, p.creator))).toBeNull();
  expect(await fixture.db.transaction((tx) => port.resolve(tx, { ...target, revisionId: randomUUID() }, p.buyer))).toBeNull();
  expect(await fixture.db.transaction((tx) => port.resolve(tx, { kind: "commission_brief" }, p.buyer))).toBeNull();
  await fixture.db.update(commissionPackages).set({ state: "paused", version: 3 }).where(eq(commissionPackages.id, p.packageId));
  expect(await fixture.db.transaction((tx) => port.resolve(tx, target, p.buyer))).not.toBeNull();
  visibility.resolveVisibleReportTarget.mockResolvedValueOnce(null as never);
  expect(await fixture.db.transaction((tx) => port.resolve(tx, target, p.buyer))).toBeNull();
  const disabled = createPackageReportTargetPort({ intakeMode: "disabled", publishingMode: "general_audience", visibility });
  expect(await fixture.db.transaction((tx) => disabled.resolve(tx, target, p.buyer))).toBeNull();
  expect(await fixture.db.select({ id: creatorPages.id }).from(creatorPages).where(eq(creatorPages.id, p.pageId))).toHaveLength(1);
});
