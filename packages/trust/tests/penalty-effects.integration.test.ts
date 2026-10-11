import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import * as schema from "@pawket/database";
import { createCreatorStandingPort } from "@pawket/identity";
import { createCommissionResolutionOrderPort } from "@pawket/orders";
import { createCommissionPaymentFactsPort, createCommissionRefundPort } from "@pawket/payments";
import { createRemovalFreezePort } from "@pawket/resolutions";
import { createTrustCasePort } from "../src/case-port.js";
import { createPenaltyService } from "../src/penalty-service.js";
import { createReportFixture } from "./report-fixture.js";
import { penaltyContext, fixtureKeyring, reportAt } from "./penalty-service-fixture.js";
const f = createReportFixture("penalty_effects"); beforeAll(async () => {
  await f.initialize(); await f.db.transaction((tx) => schema.importConfiguredBusinessCalendarVersion(tx, { version: "vn-banking-2026-v1", holidayDates: [] }));
}, 60_000); afterAll(f.dispose, 30_000);
function freeze(mode: "enabled" | "disabled") { return createRemovalFreezePort({ mode,
  orders: createCommissionResolutionOrderPort({ applicationRevision: "synthetic-penalty", newId: randomUUID }),
  refunds: createCommissionRefundPort({ keyring: fixtureKeyring, calendarVersion: "vn-banking-2026-v1" }), payments: createCommissionPaymentFactsPort(), cases: createTrustCasePort() }); }

test("creator suspension clears published head and revokes sessions; lift requires republishing", async () => {
  const c = await penaltyContext(f); const publishedId = randomUUID();
  await f.db.insert(schema.creatorPublicationRevisions).values({ id: publishedId, pageId: c.p.pageId, revisionNumber: 1, canonicalHandle: `artist-${publishedId.slice(0, 8)}`, displayName: "Artist", shortIntroduction: "Introduction", primaryDiscipline: "illustration", secondaryDisciplines: [], actorUserId: c.p.creator.userId, actorSessionId: c.p.creator.sessionId, expectedDraftVersion: 1, requestId: randomUUID(), publishedAt: reportAt });
  await f.db.update(schema.creatorPages).set({ publishedRevisionId: publishedId }).where(eq(schema.creatorPages.id, c.p.pageId));
  const { penaltyId } = await c.service.apply({ ...await c.command(), kind: "suspension", target: "creator_capability" });
  expect((await f.db.select().from(schema.identityCreatorCapabilities).where(eq(schema.identityCreatorCapabilities.id, c.capabilityId)))[0]?.state).toBe("suspended");
  expect((await f.db.select().from(schema.identitySessions).where(eq(schema.identitySessions.id, c.p.creator.sessionId)))[0]?.revokedAt).toEqual(reportAt);
  await c.service.lift({ ...await c.base("owner.trust_penalty_lift"), penaltyId, reason: "Private lift reason" });
  expect((await f.db.select().from(schema.identityCreatorCapabilities).where(eq(schema.identityCreatorCapabilities.id, c.capabilityId)))[0]?.state).toBe("active");
  expect((await f.db.select().from(schema.creatorPages).where(eq(schema.creatorPages.id, c.p.pageId)))[0]?.publishedRevisionId).toBeNull();
});
test("account suspension revokes all sessions and creator standing stays suspended until both overlapping targets end", async () => {
  const c = await penaltyContext(f); const creatorPenalty = await c.service.apply({ ...await c.command(), kind: "suspension", target: "creator_capability" });
  await f.db.insert(schema.identitySessions).values({ id: randomUUID(), userId: c.p.creator.userId, token: randomUUID(), createdAt: reportAt, updatedAt: reportAt, expiresAt: new Date(reportAt.getTime() + 86_400_000), absoluteExpiresAt: new Date(reportAt.getTime() + 86_400_000), idleExpiresAt: new Date(reportAt.getTime() + 86_400_000), lastUsedAt: reportAt });
  const accountPenalty = await c.service.apply({ ...await c.command(), kind: "suspension", target: "account" });
  expect(await f.db.transaction((tx) => createCreatorStandingPort().readCreatorStanding(tx, c.p.creator.userId))).toBe("suspended");
  expect((await f.db.select().from(schema.identitySessions).where(eq(schema.identitySessions.userId, c.p.creator.userId))).every((s) => s.revokedAt !== null)).toBe(true);
  const lift = { ...await c.base("owner.trust_penalty_lift"), penaltyId: creatorPenalty.penaltyId, reason: "Lift one" }; await c.service.lift(lift); await c.service.lift(lift);
  expect(await f.db.transaction((tx) => createCreatorStandingPort().readCreatorStanding(tx, c.p.creator.userId))).toBe("suspended");
  await c.service.lift({ ...await c.base("owner.trust_penalty_lift"), penaltyId: accountPenalty.penaltyId, reason: "Lift other" });
  expect((await f.db.select().from(schema.identityUsers).where(eq(schema.identityUsers.id, c.p.creator.userId)))[0]?.accessStatus).toBe("active");
  expect(await f.db.transaction((tx) => createCreatorStandingPort().readCreatorStanding(tx, c.p.creator.userId))).toBe("active");
});
test.each(["creator_capability", "account"] as const)("%s removal freezes two paid orders with full refund obligations", async (target) => {
  const c = await penaltyContext(f, freeze("enabled"));
  await f.db.update(schema.creatorCommissionSettings).set({ capacityLimit: 2, version: 2, updatedAt: reportAt }).where(eq(schema.creatorCommissionSettings.creatorUserId, c.p.creator.userId));
  const second = await f.paidOrder(c.p.creator);
  await c.service.apply({ ...await c.command(), kind: "removal", target });
  const orders = await f.db.select().from(schema.commissionOrders).where(eq(schema.commissionOrders.creatorUserId, c.p.creator.userId));
  expect(orders).toHaveLength(2); expect(orders.every((o) => o.state === "closed" && o.closeReason === "fulfillment_frozen")).toBe(true);
  const obligations = await f.db.select().from(schema.commissionRefundObligations).where(eq(schema.commissionRefundObligations.creatorUserId, c.p.creator.userId));
  expect(obligations).toHaveLength(2); expect(obligations.map((o) => o.orderId).sort()).toEqual([c.p.orderId, second.orderId].sort()); expect(obligations.every((o) => o.amountVnd === 50_000 && o.source === "fulfillment_freeze")).toBe(true);
  expect((await f.db.select().from(schema.identityCreatorCapabilities).where(eq(schema.identityCreatorCapabilities.id, c.capabilityId)))[0]?.state).toBe("removed");
});
test("removal with live orders refuses resolution_disabled and rolls back proof, standing and penalty", async () => {
  const c = await penaltyContext(f, freeze("disabled")); const command = { ...await c.command(), kind: "removal" as const, target: "creator_capability" as const };
  await expect(c.service.apply(command)).rejects.toMatchObject({ code: "resolution_disabled" });
  expect((await f.db.select().from(schema.identityStepUpProofs).where(eq(schema.identityStepUpProofs.id, command.stepUpProofId)))[0]?.consumedAt).toBeNull();
  expect((await f.db.select().from(schema.identityCreatorCapabilities).where(eq(schema.identityCreatorCapabilities.id, c.capabilityId)))[0]?.state).toBe("active");
  expect(await f.db.select().from(schema.trustPenalties).where(eq(schema.trustPenalties.subjectUserId, c.p.creator.userId))).toEqual([]);
});
test("creator suspension freezes only when explicitly requested; ending while disabled still restores expired standing", async () => {
  const c = await penaltyContext(f); const expiry = new Date(reportAt.getTime() + 1_000);
  const { penaltyId } = await c.service.apply({ ...await c.command(), kind: "suspension", target: "creator_capability", freezeFulfilment: true, endsAt: expiry.toISOString() }); expect(c.frozen).toHaveBeenCalledOnce();
  const disabled = createPenaltyService({ ...c.input, mode: "disabled", now: () => expiry });
  await f.db.transaction((tx) => disabled.end(tx, { penaltyId, state: "expired", actor: null, requestId: randomUUID(), at: expiry, reason: null }));
  expect((await f.db.select().from(schema.identityCreatorCapabilities).where(eq(schema.identityCreatorCapabilities.id, c.capabilityId)))[0]?.state).toBe("active");
});
