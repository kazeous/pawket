import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { commissionPolicyChecksum, createCommissionPolicyReadPort } from "@pawket/orders";
import { createCommissionPackageService, normalizeCommissionPackageDraft } from "@pawket/catalog";
import { createTipReceivingAccountEligibilityPort } from "@pawket/payments";
import { commandIds, createSePayIntegrationFixture, schema } from "../../../packages/payments/tests/sepay-integration-fixture.js";
import { commissionFixture } from "./commission-payment-test-support.js";

const url = new URL(process.env.TEST_DATABASE_URL ?? "invalid:");
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/test|ci/iu.test(url.pathname)) throw new Error("Commission catalog tests require a dedicated local test database");
const fixture = createSePayIntegrationFixture("commission_catalog");
const at = new Date("2026-09-26T02:00:00Z");
const policyId = randomUUID();
const policyFacts = { technicalVersion: "commission-v1", minimumVnd: 50_000, maximumVnd: 50_000_000, approvalKind: "synthetic", document: "Synthetic local policy. No live payments." };
beforeAll(async () => {
  await fixture.initialize();
  await fixture.db.insert(schema.commissionPolicyRevisions).values({ id: policyId, revisionNumber: 2, ...policyFacts, source: "synthetic-integration-test",
    checksum: commissionPolicyChecksum(policyFacts), effectiveAt: at, createdAt: at });
  await fixture.db.update(schema.commissionPolicyCurrent).set({ revisionId: policyId, updatedAt: at });
}, 30_000);
afterAll(fixture.dispose, 30_000);
const terms = { amountVnd: 500_000, turnaroundDays: 7, revisionAllowance: 2, reviewWindowDays: 7,
  scope: "Portrait", deliverables: "PNG", usageRights: "Personal", artistTerms: "Public artist terms", policyRevisionId: policyId };
const draft = { title: "Portrait", description: "One portrait", discipline: "illustration", route: "fixed_approval" as const, briefInstructions: "Describe your idea", terms, showcaseId: null };

async function setup() {
  const creator = await fixture.creator(); creator.setNow(at);
  const pageId = randomUUID(); const publishedRevisionId = randomUUID(); const handle = `creator-${randomUUID().slice(0, 8)}`;
  await fixture.db.insert(schema.creatorPages).values({ id: pageId, userId: creator.actor.userId, initializedFromRevisionId: randomUUID(), createdAt: at, updatedAt: at });
  await fixture.db.insert(schema.creatorPublicationRevisions).values({ id: publishedRevisionId, pageId, revisionNumber: 1, canonicalHandle: handle,
    displayName: "Artist", shortIntroduction: "Art", primaryDiscipline: "illustration", secondaryDisciplines: [], actorUserId: creator.actor.userId,
    actorSessionId: creator.actor.sessionId, expectedDraftVersion: 1, requestId: randomUUID(), publishedAt: at });
  await fixture.db.update(schema.creatorPages).set({ publishedRevisionId }).where(eq(schema.creatorPages.id, pageId));
  await fixture.db.insert(schema.creatorHandleClaims).values({ id: randomUUID(), pageId, normalizedHandle: handle, kind: "canonical", claimedAt: at });
  const gates = { identity: true, page: true, showcase: true };
  const input: Parameters<typeof createCommissionPackageService>[0] = { ...creator.common, applicationRevision: "synthetic-i6", intakeMode: "enabled", paymentsMode: "manual_only", publishingMode: "general_audience",
    identity: { lockCreator: async (_tx, actor, time) => gates.identity && actor.userId === creator.actor.userId && actor.sessionId === creator.actor.sessionId ? { sessionExpiresAt: new Date(time.getTime() + 60_000) } : null },
    policy: createCommissionPolicyReadPort({ environment: "test" }), receivingAccount: createTipReceivingAccountEligibilityPort({ ...creator.common, paymentsMode: "manual_only" }),
    visibility: { resolveVisibleReportTarget: async (_tx, target) => gates.page && (target.targetType === "page" || gates.showcase)
      ? { target, pageId, creatorUserId: creator.actor.userId, canonicalHandle: handle, displayName: "Artist", showcaseTitle: target.targetType === "showcase" ? "A portrait" : null, mediaAssetIds: [] } : null },
  };
  const service = createCommissionPackageService(input);
  const save = (data = draft) => ({ actor: creator.actor, pageId, packageId: null, expectedVersion: 0, draft: data, ...commandIds() });
  const publish = (packageId: string, expectedVersion: number) => service.changePackage({ actor: creator.actor, packageId, expectedVersion, action: "publish", policyRevisionId: policyId, ...commandIds() });
  const enable = () => service.saveSettings({ actor: creator.actor, expectedVersion: 0, enabled: true, capacityLimit: 3, ...commandIds() });
  return { creator, service, input, pageId, handle, gates, save, publish, enable };
}

describe("commission packages", () => {
  test("draft management works while intake is disabled, with ownership, replay and optimistic versions", async () => {
    const f = await setup(); const paused = createCommissionPackageService({ ...f.input, intakeMode: "disabled" });
    const command = f.save(); const id = await paused.saveDraft(command);
    expect(await paused.saveDraft(command)).toBe(id);
    await expect(paused.saveDraft({ ...command, draft: { ...draft, title: "Changed" } })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(paused.saveDraft({ ...command, actor: { ...f.creator.actor, userId: "unrelated-user" }, ...commandIds() })).rejects.toMatchObject({ code: "not_authorized" });
    const writes = await Promise.allSettled(["First", "Second"].map((title) => paused.saveDraft({ ...f.save(), packageId: id, expectedVersion: 1, draft: { ...draft, title } })));
    expect(writes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(writes.filter((result) => result.status === "rejected")[0]).toMatchObject({ reason: { code: "version_conflict" } });
    expect((await paused.getWorkspace(f.creator.actor)).packages).toHaveLength(1);
    expect(await paused.listPublic(f.handle)).toEqual([]);
    f.gates.identity = false;
    await expect(paused.saveDraft(command)).rejects.toMatchObject({ code: "not_authorized" });
  });
  test("publication makes immutable revisions; old fixed requests retain the original price", async () => {
    const f = await setup(); await f.enable(); const id = await f.service.saveDraft(f.save()); await f.publish(id, 1);
    const [first] = await f.service.listPublic(f.handle); expect(first).toMatchObject({ accepting: true, terms: { amountVnd: 500_000 } });
    await f.service.saveDraft({ ...f.save(), packageId: id, expectedVersion: 2, draft: { ...draft, terms: { ...terms, amountVnd: 600_000 } } });
    await f.publish(id, 3);
    const [current] = await f.service.listPublic(f.handle); expect(current).toMatchObject({ terms: { amountVnd: 600_000 } });
    expect(current!.revisionId).not.toBe(first!.revisionId);
    await expect(fixture.db.transaction((tx) => f.service.getIntakePackage(tx, { packageId: id, revisionId: first!.revisionId, allowPreviousRevision: false, at }))).rejects.toMatchObject({ code: "version_conflict" });
    const prior = await fixture.db.transaction((tx) => f.service.getIntakePackage(tx, { packageId: id, revisionId: first!.revisionId, allowPreviousRevision: true, at }));
    expect(prior.revision.terms?.amountVnd).toBe(500_000);
    await f.service.changePackage({ actor: f.creator.actor, packageId: id, expectedVersion: 4, action: "archive", policyRevisionId: policyId, ...commandIds() });
    expect(await f.service.listPublic(f.handle)).toEqual([]);
    await expect(fixture.db.transaction((tx) => f.service.getIntakePackage(tx, { packageId: id, revisionId: first!.revisionId, allowPreviousRevision: true, at }))).rejects.toMatchObject({ code: "not_available" });
    expect(await fixture.db.select().from(schema.commissionPackageRevisions).where(eq(schema.commissionPackageRevisions.packageId, id))).toHaveLength(2);
  });
  test("full-length Unicode public terms remain writable and idempotent", async () => {
    const f = await setup(); const text = "🎨".repeat(2_000);
    const command = { ...f.save(), draft: { ...draft, description: text, terms: { ...terms, scope: text, deliverables: text, usageRights: text, artistTerms: text } } };
    const id = await f.service.saveDraft(command); expect(await f.service.saveDraft(command)).toBe(id);
    await f.publish(id, 1);
    const workspace = await f.service.getWorkspace(f.creator.actor); expect(workspace.packages[0]?.draft.terms?.scope).toBe(text);
  });
  test("public projection honors current page/showcase holds and excludes private financial fields", async () => {
    const f = await setup(); await f.enable(); const showcaseId = randomUUID();
    const id = await f.service.saveDraft({ ...f.save(), draft: { ...draft, showcaseId } }); await f.publish(id, 1);
    const [before] = await f.service.listPublic(f.handle); expect(before?.showcaseId).toBe(showcaseId);
    expect(Object.keys(before!).sort()).toEqual(["accepting", "briefInstructions", "capacityAvailable", "description", "discipline", "id", "policy", "revisionId", "route", "showcaseId", "terms", "title"].sort());
    f.gates.showcase = false; expect((await f.service.listPublic(f.handle))[0]?.showcaseId).toBeNull();
    f.gates.page = false; expect(await f.service.listPublic(f.handle)).toEqual([]);
    f.gates.page = true;
    const missingAccount = createCommissionPackageService({ ...f.input, receivingAccount: { getCurrentTipReceivingAccount: async () => null } });
    expect((await missingAccount.listPublic(f.handle))[0]?.accepting).toBe(true);
    const pausedPayments = createCommissionPackageService({ ...f.input, paymentsMode: "disabled" });
    expect((await pausedPayments.listPublic(f.handle))[0]?.accepting).toBe(true);
    const immediate = await f.service.saveDraft({ ...f.save(), draft: { ...draft, route: "fixed_immediate" } }); await f.publish(immediate, 1);
    expect((await missingAccount.listPublic(f.handle)).find((item) => item.id === immediate)?.accepting).toBe(false);
    expect((await pausedPayments.listPublic(f.handle)).find((item) => item.id === immediate)?.accepting).toBe(false);
    const production = createCommissionPackageService({ ...f.input, policy: createCommissionPolicyReadPort({ environment: "production" }) });
    expect((await production.listPublic(f.handle))[0]?.accepting).toBe(false);
    await expect(fixture.db.transaction((tx) => production.getIntakePackage(tx, { packageId: id, revisionId: before!.revisionId, allowPreviousRevision: false, at }))).rejects.toMatchObject({ code: "policy_changed" });
  });
  test("nonarchived package quota serializes concurrent creation and archive frees one place", async () => {
    const f = await setup(); const ids = [];
    for (let i = 0; i < 11; i++) ids.push(await f.service.saveDraft(f.save()));
    const outcomes = await Promise.allSettled([f.service.saveDraft(f.save()), f.service.saveDraft(f.save())]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((item) => item.status === "rejected")).toMatchObject({ reason: { code: "capacity_full" } });
    await f.service.changePackage({ actor: f.creator.actor, packageId: ids[0]!, expectedVersion: 1, action: "archive", policyRevisionId: policyId, ...commandIds() });
    await f.service.saveDraft(f.save());
    expect((await f.service.getWorkspace(f.creator.actor)).packages).toHaveLength(12);
  });
  test("lowering capacity below usage preserves reservations and blocks the next reservation", async () => {
    const f = await setup(); await f.enable();
    const first = await commissionFixture(fixture, f.creator); await commissionFixture(fixture, f.creator);
    await f.service.saveSettings({ actor: f.creator.actor, expectedVersion: 1, enabled: true, capacityLimit: 1, ...commandIds() });
    expect((await f.service.getWorkspace(f.creator.actor)).settings).toMatchObject({ version: 2, capacityLimit: 1, used: 2 });
    await expect(commissionFixture(fixture, f.creator)).rejects.toMatchObject({ cause: { code: "23514" } });
    expect(await fixture.db.select().from(schema.commissionReservations).where(and(eq(schema.commissionReservations.creatorUserId, f.creator.actor.userId), eq(schema.commissionReservations.state, "reserved")))).toHaveLength(2);
    expect((await fixture.db.select().from(schema.commissionOrders).where(eq(schema.commissionOrders.id, first.orderId)))[0]?.state).toBe("awaiting_payment");
  });
  test("rejects invalid routes, hidden executable fields and incompatible custom terms", () => {
    expect(() => normalizeCommissionPackageDraft({ ...draft, route: "auction" })).toThrow();
    expect(() => normalizeCommissionPackageDraft({ ...draft, route: "custom_quote" })).toThrow();
    expect(() => normalizeCommissionPackageDraft({ ...draft, get title() { throw new Error("must not execute"); } })).toThrowError("invalid_request");
    expect(() => normalizeCommissionPackageDraft({ ...draft, discipline: "unsupported" })).toThrow();
  });
});
