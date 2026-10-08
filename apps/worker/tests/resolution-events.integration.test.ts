import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { insertOutboxEvent } from "@pawket/database";
import { createCommissionResolutionOrderPort } from "@pawket/orders";
import { createCommissionPaymentFactsPort, createCommissionRefundPort } from "@pawket/payments";
import { createDisputeService, createLateClaimService, createOwnerResolutionService, createResolutionCommandKit } from "@pawket/resolutions";
import { createTrustCasePort } from "@pawket/trust";
import { OUTBOX_JOB, type SystemOutboxJob } from "@pawket/queue";
import { createCommissionResolutionTestFixture, resolutions } from "../../web/tests/commission-resolution-test-support.js";
import { commandIds, schema } from "../../../packages/payments/tests/sepay-integration-fixture.js";
import { RESOLUTION_OUTBOX_EVENTS, validateResolutionOutboxEvent } from "../src/resolution-events.js";
import { createWorkerJobProcessor } from "../src/worker-runtime.js";

const f = createCommissionResolutionTestFixture("i8events");
beforeAll(f.initialize, 60_000); afterAll(f.dispose, 30_000);
type Paid = Awaited<ReturnType<typeof f.paidOrder>>;
function ports(p: Pick<Paid, "s">) {
  return { orders: createCommissionResolutionOrderPort({ applicationRevision: "synthetic-i8", newId: randomUUID }),
    refunds: createCommissionRefundPort({ keyring: p.s.input.keyring, calendarVersion: "vn-proposals-test" }),
    payments: createCommissionPaymentFactsPort(), cases: createTrustCasePort(), mode: "enabled" as const };
}
const job = (row: typeof schema.systemOutbox.$inferSelect): SystemOutboxJob => ({ outboxEventId: row.id, eventType: row.eventType,
  eventVersion: row.eventVersion, aggregateType: row.aggregateType, aggregateId: row.aggregateId, payload: row.payload, occurredAt: row.occurredAt.toISOString() });
async function journeys() {
  const p = await f.deliveredOrder(); const port = ports(p); const owner = await p.s.buyer();
  const kit = createResolutionCommandKit({ ...p.s.creator.common, session: p.s.input.identity, consumeStepUpProof: async () => true });
  const ownerService = createOwnerResolutionService(kit, { ...port, applicationRevision: "synthetic-i8", standing: { readCreatorStanding: async () => "suspended" } });
  const ownerCommand = () => ({ owner, stepUpProofId: randomUUID(), ...commandIds() });
  const dispute = await createDisputeService(kit, port).openDispute({ actor: p.buyer, orderId: p.orderId, expectedVersion: 3,
    reason: "not_as_agreed", statement: "Synthetic statement", requestedOutcome: { kind: "close", refundAmountVnd: 100_000 }, acknowledgeStaffReview: true, ...commandIds() });
  await createDisputeService(kit, port).addStatement({ actor: p.creator, disputeId: dispute.disputeId, text: "Synthetic response", ...commandIds() });
  const ruling = await ownerService.rule({ ...ownerCommand(), disputeId: dispute.disputeId, outcome: "close", refundAmountVnd: 100_000, reasoning: "Synthetic reasoning" });
  await ownerService.correctRuling({ ...ownerCommand(), rulingId: ruling.rulingId, newRefundAmountVnd: 50_000, reason: "Synthetic correction" });
  const a = await f.paidOrder(); const proposal = await resolutions(a).propose({ actor: a.buyer, orderId: a.orderId, expectedVersion: 2,
    kind: "cancel_with_refund", refundAmountVnd: 100_000, note: "Synthetic proposal", ...commandIds() });
  await resolutions(a).respondToProposal({ actor: a.creator, proposalId: proposal.proposalId, response: "decline", ...commandIds() });
  const s = await f.setup(); const orderId = await s.service.request(s.request());
  const [order] = await f.db.select().from(schema.commissionOrders).where(eq(schema.commissionOrders.id, orderId)); s.creator.setNow(order!.expiresAt!); await s.service.expireDue();
  const late = createLateClaimService(createResolutionCommandKit({ ...s.creator.common, session: s.input.identity }), ports({ s }));
  const claim = await late.fileLateClaim({ actor: s.buyerActor, orderId, transferAt: s.creator.now(), amountVnd: 100_000, bankReference: "SYNTHETIC", ...commandIds() });
  await late.answerLateClaim({ actor: s.creator.actor, claimId: claim.claimId, received: false, ...commandIds() });
  const frozen = await f.paidOrder(); const frozenOwner = await frozen.s.buyer();
  const freeze = createOwnerResolutionService(createResolutionCommandKit({ ...frozen.s.creator.common, session: frozen.s.input.identity, consumeStepUpProof: async () => true }),
    { ...ports(frozen), applicationRevision: "synthetic-i8", standing: { readCreatorStanding: async () => "suspended" } });
  await freeze.freezeFulfillment({ owner: frozenOwner, stepUpProofId: randomUUID(), creatorUserId: frozen.creator.userId, reason: "Synthetic freeze", ...commandIds() });
  return f.db.select().from(schema.systemOutbox).where(inArray(schema.systemOutbox.eventType, [...RESOLUTION_OUTBOX_EVENTS]));
}
test("resolution events validate against all durable source rows and route without a notification handoff", async () => {
  const rows = await journeys(); expect(new Set(rows.map((row) => row.eventType))).toEqual(RESOLUTION_OUTBOX_EVENTS);
  const acknowledge = vi.fn(async () => true); const logger = { info: vi.fn(), error: vi.fn() };
  const processor = createWorkerJobProcessor({ database: f.db, acknowledge, logger });
  for (const row of rows) {
    const event = job(row); await expect(validateResolutionOutboxEvent(f.db, event)).resolves.toBeUndefined();
    await processor({ id: row.id, name: OUTBOX_JOB, data: event } as never); await processor({ id: row.id, name: OUTBOX_JOB, data: event } as never);
    await expect(validateResolutionOutboxEvent(f.db, { ...event, payload: { ...event.payload, privateText: "private-content" } })).rejects.toThrow("Invalid resolution worker source");
    const wrongAggregate = randomUUID(); const forgedId = await f.db.transaction((tx) => insertOutboxEvent(tx, { eventType: row.eventType,
      eventVersion: 1, aggregateType: row.aggregateType, aggregateId: wrongAggregate, payload: row.payload, occurredAt: row.occurredAt }));
    await expect(validateResolutionOutboxEvent(f.db, { ...event, outboxEventId: forgedId, aggregateId: wrongAggregate })).rejects.toThrow("Invalid resolution worker source");
    const occurredAt = new Date(row.occurredAt.getTime() + 1); const wrongTime = await f.db.transaction((tx) => insertOutboxEvent(tx, { eventType: row.eventType,
      eventVersion: 1, aggregateType: row.aggregateType, aggregateId: row.aggregateId, payload: row.payload, occurredAt }));
    await expect(validateResolutionOutboxEvent(f.db, { ...event, outboxEventId: wrongTime, occurredAt: occurredAt.toISOString() })).rejects.toThrow("Invalid resolution worker source");
    const patch = "state" in row.payload ? { state: "pending" } : "kind" in row.payload ? { kind: "complete_with_refund" } :
      "authorRole" in row.payload ? { authorRole: "buyer" } : "outcome" in row.payload ? { outcome: "complete" } :
      "effect" in row.payload ? { effect: "increased" } : "closedOrders" in row.payload ? { closedOrders: Number(row.payload.closedOrders) + 1 } :
      "sourceId" in row.payload ? { sourceId: randomUUID() } : { orderId: randomUUID() };
    const payload = { ...row.payload, ...patch }; const forgedPayload = await f.db.transaction((tx) => insertOutboxEvent(tx, { eventType: row.eventType,
      eventVersion: 1, aggregateType: row.aggregateType, aggregateId: row.aggregateId, payload, occurredAt: row.occurredAt }));
    await expect(validateResolutionOutboxEvent(f.db, { ...event, outboxEventId: forgedPayload, payload })).rejects.toThrow("Invalid resolution worker source");
  }
  expect(acknowledge).toHaveBeenCalledTimes(rows.length * 2); expect(JSON.stringify(logger.error.mock.calls)).not.toContain("private-content");
  await expect(validateResolutionOutboxEvent(f.db, { ...job(rows[0]!), eventType: "resolution.unknown.v1" })).rejects.toThrow("Invalid resolution worker source");
});
test("escalated claim events remain valid after an owner ends the claim", async () => {
  const s = await f.setup(); const orderId = await s.service.request(s.request()); const p = { s };
  const [order] = await f.db.select().from(schema.commissionOrders).where(eq(schema.commissionOrders.id, orderId)); s.creator.setNow(order!.expiresAt!); await s.service.expireDue();
  const owner = await s.buyer(); const kit = createResolutionCommandKit({ ...s.creator.common, session: s.input.identity, consumeStepUpProof: async () => true });
  const service = createLateClaimService(kit, ports(p)); const { claimId } = await service.fileLateClaim({ actor: s.buyerActor, orderId,
    transferAt: s.creator.now(), amountVnd: 100_000, bankReference: "SYNTHETIC", ...commandIds() });
  await service.answerLateClaim({ actor: s.creator.actor, claimId, received: false, ...commandIds() });
  s.creator.setNow(new Date(s.creator.now().getTime() + 1));
  await createOwnerResolutionService(kit, { ...ports(p), applicationRevision: "synthetic-i8" }).ruleLateClaim({ owner, stepUpProofId: randomUUID(),
    claimId, outcome: "rejected", reason: "Synthetic ruling", ...commandIds() });
  const rows = await f.db.select().from(schema.systemOutbox).where(eq(schema.systemOutbox.aggregateId, claimId));
  for (const row of rows) await expect(validateResolutionOutboxEvent(f.db, job(row))).resolves.toBeUndefined();
});
test("every resolution and refund outbox payload uses the complete fixed id, state, kind and count allow-list", async () => {
  const rows = await journeys();
  const allowed = new Set(["proposalId", "orderId", "kind", "state", "disputeId", "statementId", "authorRole", "rulingId", "outcome",
    "correctionId", "effect", "claimId", "creatorUserId", "closedOrders", "caseId", "sourceId", "policyRevisionId", "correlationId"]);
  expect(new Set(rows.map((row) => row.eventType))).toEqual(RESOLUTION_OUTBOX_EVENTS);
  for (const row of rows) expect(Object.keys(row.payload).every((key) => allowed.has(key))).toBe(true);
  expect(rows.some((row) => row.eventType === "resolution.late_claim_ended.v1" && row.payload.state === "escalated")).toBe(true);
});
