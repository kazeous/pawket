import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createCommissionThreadService } from "@pawket/commission-files";
import { createIdentityEnforcementPort } from "@pawket/identity";
import { createCommissionFileAccessPort, createCommissionResolutionOrderPort, lockCommissionCreator, COMMISSION_POLICY } from "@pawket/orders";
import { createCommissionRefundPort } from "@pawket/payments";
import { createDisputeService, createResolutionCommandKit } from "@pawket/resolutions";
import { createPenaltyService, createPrivateReportService, createReportService, createTrustCasePort, createTrustRestrictionPort, type TrustRestriction } from "@pawket/trust";
import { commandIds, schema } from "../../../packages/payments/tests/sepay-integration-fixture.js";
import { createCommissionOrderTestFixture } from "./commission-order-test-support.js";
import { createTrustEnforcementHttpHandlers } from "../src/platform/trust-enforcement-http.js";

const f = createCommissionOrderTestFixture("restriction_effects"); beforeAll(f.initialize, 60_000); afterAll(f.dispose, 30_000);
const restrictions = createTrustRestrictionPort({ mode: "enabled" });
type Setup = Awaited<ReturnType<typeof f.setup>>;
async function restrict(s: Setup, orderId: string, userId: string, restriction: TrustRestriction) {
  const { caseId } = await f.db.transaction((tx) => createTrustCasePort().openCase(tx, { kind: "dispute", orderId, sourceType: "commission_dispute", sourceId: randomUUID(), policyRevisionId: s.policyId, requestId: randomUUID(), at: s.creator.now() }));
  const service = createPenaltyService({ db: f.db, mode: "enabled", keyring: s.input.keyring, lookupHmacKey: s.input.lookupHmacKey, applicationRevision: "synthetic-restrictions", fence: { lockCreatorFence: lockCommissionCreator },
    identity: createIdentityEnforcementPort({ clearPublishedHeadForSuspension: async () => ({ pageId: null, previousPublishedRevisionId: null }) }),
    freeze: { freezeForRemoval: async () => ({ closedOrders: 0 }) }, policies: { readCurrentIds: async () => ({ enforcementRevisionId: null }) }, consumeStepUpProof: async () => true, now: s.creator.now });
  const result = await service.apply({ owner: s.creator.actor, stepUpProofId: randomUUID(), subjectUserId: userId, source: { caseId }, kind: "restriction", restriction, reasonCategory: "other", explanation: "Synthetic restriction", ...commandIds() });
  return { ...result, service };
}
test("commission_buying blocks request but messages and dispute opening stay allowed", async () => {
  const p = await f.paidOrder({ restrictions }); await restrict(p.s, p.orderId, p.buyer.userId, "commission_buying");
  await expect(p.s.service.request(p.s.request())).rejects.toMatchObject({ code: "not_available" });
  const thread = createCommissionThreadService({ ...p.s.creator.common, filesMode: "enabled", fulfillmentMode: "enabled", sessions: p.s.input.identity, orders: createCommissionFileAccessPort({ catalog: p.s.catalog }) });
  await expect(thread.sendMessage({ actor: p.buyer, orderId: p.orderId, text: "Allowed message", fileIds: [], ...commandIds() })).resolves.toMatchObject({ sequence: 1 });
  p.s.creator.advance(15 * 86_400_000);
  const disputes = createDisputeService(createResolutionCommandKit({ ...p.s.creator.common, session: p.s.input.identity }), { mode: "enabled", restrictions,
    orders: createCommissionResolutionOrderPort({ applicationRevision: "synthetic-restrictions", newId: randomUUID }), cases: createTrustCasePort(), refunds: createCommissionRefundPort({ keyring: p.s.input.keyring, calendarVersion: "unused" }) });
  await expect(disputes.openDispute({ actor: p.buyer, orderId: p.orderId, expectedVersion: 2, reason: "not_delivered", statement: "Allowed dispute", requestedOutcome: { kind: "close", refundAmountVnd: 500_000 }, acknowledgeStaffReview: true, ...commandIds() })).resolves.toHaveProperty("disputeId");
});
test.each(["fixed_immediate", "fixed_approval", "custom_quote"] as const)("commission_intake refuses request and applicable acceptance/quote for %s without revealing the restriction", async (route) => {
  const s = await f.setup(route, { restrictions }); const orderId = await s.service.request(s.request());
  let quoteId: string | null = null;
  if (route === "custom_quote") {
    await s.service.quote({ actor: s.creator.actor, orderId, expectedVersion: 1, terms: s.terms, ttlMs: COMMISSION_POLICY.defaultQuoteTtlMs, ...commandIds() });
    quoteId = (await s.service.getOrder({ actor: s.buyerActor, orderId })).quote!.id;
  }
  await restrict(s, orderId, s.creator.actor.userId, "commission_intake");
  await expect(s.service.request(s.request(await s.buyer()))).rejects.toMatchObject({ code: "not_available" });
  if (route !== "fixed_immediate") await expect(s.service.accept({ actor: route === "fixed_approval" ? s.creator.actor : s.buyerActor, orderId, expectedVersion: quoteId ? 2 : 1, quoteRevisionId: quoteId, policyRevisionId: s.policyId, acceptTerms: true, abuseKeyHash: s.request().abuseKeyHash, ...commandIds() })).rejects.toMatchObject({ code: "not_available" });
  if (route === "custom_quote") await expect(s.service.quote({ actor: s.creator.actor, orderId, expectedVersion: 2, terms: s.terms, ttlMs: COMMISSION_POLICY.defaultQuoteTtlMs, ...commandIds() })).rejects.toMatchObject({ code: "not_available" });
});
test("commission_buying blocks buyer quote acceptance, while creator fixed acceptance stays allowed", async () => {
  for (const route of ["fixed_approval", "custom_quote"] as const) {
    const s = await f.setup(route, { restrictions }); const orderId = await s.service.request(s.request());
    let quoteRevisionId: string | null = null;
    if (route === "custom_quote") { await s.service.quote({ actor: s.creator.actor, orderId, expectedVersion: 1, terms: s.terms, ttlMs: COMMISSION_POLICY.defaultQuoteTtlMs, ...commandIds() }); quoteRevisionId = (await s.service.getOrder({ actor: s.buyerActor, orderId })).quote!.id; }
    await restrict(s, orderId, s.buyerActor.userId, "commission_buying");
    const result = s.service.accept({ actor: route === "custom_quote" ? s.buyerActor : s.creator.actor, orderId, expectedVersion: quoteRevisionId ? 2 : 1, quoteRevisionId, policyRevisionId: s.policyId, acceptTerms: true, abuseKeyHash: s.request().abuseKeyHash, ...commandIds() });
    if (route === "custom_quote") await expect(result).rejects.toMatchObject({ code: "not_available" }); else await expect(result).resolves.toBe(orderId);
  }
});
test("dispute_opening blocks opening, and existing dispute statements stay allowed", async () => {
  const p = await f.paidOrder({ restrictions }); p.s.creator.advance(15 * 86_400_000);
  const disputes = createDisputeService(createResolutionCommandKit({ ...p.s.creator.common, session: p.s.input.identity }), { mode: "enabled", restrictions,
    orders: createCommissionResolutionOrderPort({ applicationRevision: "synthetic-restrictions", newId: randomUUID }), cases: createTrustCasePort(), refunds: createCommissionRefundPort({ keyring: p.s.input.keyring, calendarVersion: "unused" }) });
  const c = { actor: p.buyer, orderId: p.orderId, expectedVersion: 2, reason: "not_delivered" as const, statement: "Statement", requestedOutcome: { kind: "close" as const, refundAmountVnd: 500_000 }, acknowledgeStaffReview: true as const, ...commandIds() };
  const blocked = await restrict(p.s, p.orderId, p.buyer.userId, "dispute_opening"); await expect(disputes.openDispute(c)).rejects.toMatchObject({ code: "not_available" });
  await blocked.service.lift({ owner: p.creator, stepUpProofId: randomUUID(), penaltyId: blocked.penaltyId, reason: "Lift", ...commandIds() });
  const { disputeId } = await disputes.openDispute(c); await restrict(p.s, p.orderId, p.buyer.userId, "dispute_opening");
  await expect(disputes.addStatement({ actor: p.buyer, disputeId, text: "Still allowed", ...commandIds() })).resolves.toHaveProperty("statementId");
});
test("reporting blocks both report surfaces with generic refusals and leaves no report rows", async () => {
  const p = await f.paidOrder({ restrictions }); await restrict(p.s, p.orderId, p.buyer.userId, "reporting");
  const [page] = await f.db.select().from(schema.creatorPages).where(eq(schema.creatorPages.id, p.s.pageId));
  const target = { targetType: "page" as const, targetId: p.s.pageId, publicationRevisionId: page!.publishedRevisionId! };
  const reports = createReportService({ db: f.db, lookupHmacKey: p.s.input.lookupHmacKey, clock: p.s.creator.now, restrictions,
    catalogModeration: { resolveVisibleReportTarget: async () => ({ target, creatorUserId: p.creator.userId, pageId: p.s.pageId, canonicalHandle: p.s.handle, displayName: "Artist", showcaseTitle: null, mediaAssetIds: [] }), readRevisionTarget: async () => null } });
  await expect(reports.submitReport({ requester: { kind: "authenticated", actorUserId: p.buyer.userId }, target, reason: "other" })).rejects.toMatchObject({ code: "REPORT_NOT_ACCEPTED" });
  const privateReports = createPrivateReportService({ db: f.db, mode: "enabled", keyring: p.s.input.keyring, lookupHmacKey: p.s.input.lookupHmacKey, challengeKey: p.s.input.lookupHmacKey, restrictions, now: p.s.creator.now,
    policies: { readCurrentIds: async () => ({ communityRulesRevisionId: null, enforcementRevisionId: null }) }, targets: { resolve: async () => ({ kind: "commission_package", targetId: p.s.packageId, packageRevisionId: p.s.revisionId, orderId: null, contentOwnerUserId: p.creator.userId }) } });
  const origin = "https://pawket.example.invalid";
  const http = createTrustEnforcementHttpHandlers({ appBaseUrl: origin, lookupHmacKey: p.s.input.lookupHmacKey, reports: privateReports, authenticate: async () => p.buyer });
  const response = await http.submit(new Request(`${origin}/api/v1/reports`, { method: "POST", headers: { origin, "content-type": "application/json", "idempotency-key": randomUUID() }, body: JSON.stringify({ target: { kind: "commission_package", packageId: p.s.packageId, revisionId: p.s.revisionId }, reason: "other" }) }));
  expect(response.status).toBe(400); expect(await response.json()).toEqual({ code: "REPORT_NOT_ACCEPTED" });
  expect(await f.db.select().from(schema.trustReports).where(eq(schema.trustReports.reporterUserId, p.buyer.userId))).toEqual([]);
  expect(await f.db.select().from(schema.publicContentReports).where(eq(schema.publicContentReports.reporterUserId, p.buyer.userId))).toEqual([]);
});
