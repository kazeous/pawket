import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import * as schema from "@pawket/database";
import { createCommissionResolutionOrderPort } from "@pawket/orders";
import { createCommissionPaymentFactsPort, createCommissionRefundPort } from "@pawket/payments";
import { createDisputeService, createProposalService, createRemovalFreezePort, createResolutionCommandKit } from "@pawket/resolutions";
import { createTrustCasePort } from "@pawket/trust";
import { OUTBOX_JOB, type SystemOutboxJob } from "@pawket/queue";
import { createReportFixture } from "../../../packages/trust/tests/report-fixture.js";
import { penaltyContext, fixtureKeyring, reportAt } from "../../../packages/trust/tests/penalty-service-fixture.js";
import { createWorkerJobProcessor } from "../src/worker-runtime.js";
import { validateResolutionOutboxEvent } from "../src/resolution-events.js";

const f = createReportFixture("worker_penalty_removal");
beforeAll(async () => {
  await f.initialize();
  await f.db.transaction((tx) => schema.importConfiguredBusinessCalendarVersion(tx, { version: "vn-penalty-worker", holidayDates: [] }));
}, 60_000);
afterAll(f.dispose, 30_000);
const commandIds = () => ({ idempotencyKey: randomUUID(), requestId: randomUUID() });
const job = (row: typeof schema.systemOutbox.$inferSelect): SystemOutboxJob => ({ outboxEventId: row.id, eventType: row.eventType,
  eventVersion: row.eventVersion, aggregateType: row.aggregateType, aggregateId: row.aggregateId, payload: row.payload, occurredAt: row.occurredAt.toISOString() });

test.each(["creator_capability", "account"] as const)("every outbox row from %s removal of a creator with two paid orders is acknowledged", async (target) => {
  const ports = { mode: "enabled" as const, orders: createCommissionResolutionOrderPort({ applicationRevision: "synthetic-penalty-worker", newId: randomUUID }),
    refunds: createCommissionRefundPort({ keyring: fixtureKeyring, calendarVersion: "vn-penalty-worker" }),
    payments: createCommissionPaymentFactsPort(), cases: createTrustCasePort() };
  const c = await penaltyContext(f, createRemovalFreezePort(ports));
  await f.db.update(schema.creatorCommissionSettings).set({ capacityLimit: 2, version: 2, updatedAt: reportAt }).where(eq(schema.creatorCommissionSettings.creatorUserId, c.p.creator.userId));
  const second = await f.paidOrder(c.p.creator);
  const kit = createResolutionCommandKit({ db: f.db, keyring: fixtureKeyring, lookupHmacKey: c.input.lookupHmacKey, now: () => reportAt,
    session: { async getTipSessionAssurance(_tx, actor, at) {
      const parties = [c.p.creator, c.p.buyer, second.buyer];
      return parties.some((p) => p.userId === actor.userId && p.sessionId === actor.sessionId) ? { sessionExpiresAt: new Date(at.getTime() + 60_000) } : null;
    } } });
  const proposals = createProposalService(kit, ports);
  const declined = await proposals.propose({ actor: c.p.buyer, orderId: c.p.orderId, expectedVersion: 2, kind: "cancel_with_refund",
    refundAmountVnd: 50_000, note: "Synthetic proposal", ...commandIds() });
  await proposals.respondToProposal({ actor: c.p.creator, proposalId: declined.proposalId, response: "decline", ...commandIds() });
  const dispute = await createDisputeService(kit, ports).openDispute({ actor: c.p.buyer, orderId: c.p.orderId, expectedVersion: 2,
    reason: "not_as_agreed", statement: "Synthetic dispute", requestedOutcome: { kind: "close", refundAmountVnd: 50_000 }, acknowledgeStaffReview: true, ...commandIds() });
  const pending = await proposals.propose({ actor: second.buyer, orderId: second.orderId, expectedVersion: 2, kind: "cancel_with_refund",
    refundAmountVnd: 50_000, note: "Synthetic pending proposal", ...commandIds() });

  const before = new Set((await f.db.select({ id: schema.systemOutbox.id }).from(schema.systemOutbox)).map((row) => row.id));
  const { penaltyId } = await c.service.apply({ ...await c.command(), source: { caseId: dispute.caseId }, kind: "removal", target });
  // No event-type filter: pass EVERY row produced by the penalty transaction through the real processor/validators.
  const rows = (await f.db.select().from(schema.systemOutbox)).filter((row) => !before.has(row.id));
  expect(rows.length).toBeGreaterThan(0);
  const acknowledge = vi.fn(schema.acknowledgeOutboxEvent); const logger = { info: vi.fn(), error: vi.fn() };
  const processor = createWorkerJobProcessor({ database: f.db, acknowledge, logger });
  for (const row of rows) {
    await expect(processor({ id: row.id, name: OUTBOX_JOB, data: job(row) } as never), row.eventType).resolves.toBeUndefined();
    expect(acknowledge).toHaveBeenCalledWith(f.db, { eventId: row.id });
    await expect(acknowledge.mock.results.at(-1)?.value).resolves.toBe(true);
  }
  expect(acknowledge).toHaveBeenCalledTimes(rows.length); expect(logger.error).not.toHaveBeenCalled();
  expect((await f.db.select().from(schema.systemOutbox).where(inArray(schema.systemOutbox.id, rows.map((row) => row.id)))).every((row) => row.publishedAt !== null)).toBe(true);
  expect(rows.some((row) => row.eventType === "resolution.fulfillment_frozen.v1")).toBe(false);
  expect(rows.filter((row) => row.eventType === "commission.closed.v1")).toHaveLength(2);
  expect(rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ eventType: "trust.penalty_applied.v1", aggregateId: penaltyId }),
    expect.objectContaining({ eventType: "resolution.proposal_ended.v1", payload: { proposalId: pending.proposalId, orderId: second.orderId, state: "superseded" } }),
    expect.objectContaining({ eventType: "resolution.dispute_closed.v1", payload: { disputeId: dispute.disputeId, orderId: c.p.orderId, state: "superseded" } }),
  ]));
  const orders = await f.db.select().from(schema.commissionOrders).where(inArray(schema.commissionOrders.id, [c.p.orderId, second.orderId]));
  expect(orders).toHaveLength(2); expect(orders.every((row) => row.state === "closed" && row.closeReason === "fulfillment_frozen")).toBe(true);
  const refunds = await f.db.select().from(schema.commissionRefundObligations).where(eq(schema.commissionRefundObligations.creatorUserId, c.p.creator.userId));
  expect(refunds).toHaveLength(2); expect(refunds.every((row) => row.source === "fulfillment_freeze" && row.amountVnd === 50_000)).toBe(true);
  expect(await f.db.select().from(schema.commissionRefundEvents).where(inArray(schema.commissionRefundEvents.obligationId, refunds.map((row) => row.id)))).toMatchObject([{ action: "created" }, { action: "created" }]);
  if (target === "account") expect((await f.db.select().from(schema.identityUsers).where(eq(schema.identityUsers.id, c.p.creator.userId)))[0]?.accessStatus).toBe("closed");
  // A penalty audit must still never satisfy Stage A's dedicated owner-freeze contract.
  const forgedId = await f.db.transaction((tx) => schema.insertOutboxEvent(tx, { eventType: "resolution.fulfillment_frozen.v1", eventVersion: 1,
    aggregateType: "creator", aggregateId: c.p.creator.userId, payload: { creatorUserId: c.p.creator.userId, closedOrders: 2 }, occurredAt: reportAt }));
  const [forged] = await f.db.select().from(schema.systemOutbox).where(eq(schema.systemOutbox.id, forgedId));
  await expect(validateResolutionOutboxEvent(f.db, job(forged!))).rejects.toThrow("Invalid resolution worker source");
});
