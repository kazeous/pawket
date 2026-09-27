import { randomUUID } from "node:crypto";
import { like } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { createCreatorCommissionPaymentService } from "@pawket/payments";
import { OUTBOX_JOB, type SystemOutboxJob } from "@pawket/queue";
import { createWorkerJobProcessor } from "../../worker/src/worker-runtime.js";
import { COMMISSION_OUTBOX_EVENTS } from "../../worker/src/commission-events.js";
import { commandIds, schema } from "../../../packages/payments/tests/sepay-integration-fixture.js";
import { createCommissionOrderTestFixture } from "./commission-order-test-support.js";

const f = createCommissionOrderTestFixture("commission_events");
beforeAll(f.initialize, 30_000); afterAll(f.dispose, 30_000);

test("the worker validates every commission source and replay without a tip email handoff", async () => {
  const s = await f.setup(); const orderId = await s.service.request(s.request());
  const detail = await s.service.getOrder({ actor: s.buyerActor, orderId });
  const claim = { actor: s.buyerActor, orderId, expectedVersion: detail.version, ...commandIds() };
  await s.service.claimTransfer(claim); await s.service.claimTransfer(claim);
  await s.service.claimTransfer({ ...claim, ...commandIds() });
  await createCreatorCommissionPaymentService({ ...s.creator.common, applicationRevision: "synthetic-i6", paymentsMode: "manual_only", recentAuthMs: 900_000,
    totpAuthMs: 300_000, assurance: s.creator.assurance, commissions: s.service.paymentsLifecycle }).confirm({ actor: s.creator.actor,
    paymentIntentId: detail.payment!.id, observedAmountVnd: detail.payment!.amountVnd, observedTransferReference: detail.payment!.reference,
    observedBankTransactionId: randomUUID(), attestedReceived: true, ...commandIds() });
  const q = await f.setup("custom_quote"); const requestId = await q.service.request(q.request());
  await q.service.quote({ actor: q.creator.actor, orderId: requestId, expectedVersion: 1, terms: q.terms, ttlMs: 86_400_000, ...commandIds() });
  await q.service.close({ actor: q.buyerActor, orderId: requestId, expectedVersion: 2, ...commandIds() });
  await q.catalog.changePackage({ actor: q.creator.actor, packageId: q.packageId, expectedVersion: 2, action: "pause", policyRevisionId: q.policyId, ...commandIds() });
  await q.catalog.changePackage({ actor: q.creator.actor, packageId: q.packageId, expectedVersion: 3, action: "archive", policyRevisionId: q.policyId, ...commandIds() });
  const rows = await f.db.select().from(schema.systemOutbox).where(like(schema.systemOutbox.eventType, "commission.%"));
  expect(rows.filter((row) => row.eventType === "commission.transfer_claimed.v1")).toHaveLength(1);
  expect(new Set(rows.map((row) => row.eventType))).toEqual(COMMISSION_OUTBOX_EVENTS);
  const acknowledge = vi.fn(async () => true); const logger = { info: vi.fn(), error: vi.fn() };
  const processor = createWorkerJobProcessor({ database: f.db, acknowledge, logger });
  const events: SystemOutboxJob[] = rows.map((row) => ({ outboxEventId: row.id, eventType: row.eventType, eventVersion: row.eventVersion,
    aggregateType: row.aggregateType, aggregateId: row.aggregateId, payload: row.payload, occurredAt: row.occurredAt.toISOString() }));
  for (const data of events) {
    await processor({ id: data.outboxEventId, name: OUTBOX_JOB, data } as never);
    await processor({ id: data.outboxEventId, name: OUTBOX_JOB, data } as never);
  }
  expect(acknowledge).toHaveBeenCalledTimes(events.length * 2);
  acknowledge.mockClear(); const event = events.find((item) => item.eventType === "commission.confirmed.v1")!;
  for (const data of [
    { ...event, payload: { ...event.payload, orderId: randomUUID() } },
    { ...event, payload: { ...event.payload, privateBrief: "never log this" } },
    { ...event, aggregateId: randomUUID() },
    { ...event, outboxEventId: randomUUID() },
    { ...event, eventType: "commission.closed.v1" },
  ]) await expect(processor({ id: data.outboxEventId, name: OUTBOX_JOB, data } as never)).rejects.toThrow("Worker job processing failed");
  expect(acknowledge).not.toHaveBeenCalled(); expect(JSON.stringify(logger.error.mock.calls)).not.toContain("never log this");
});
