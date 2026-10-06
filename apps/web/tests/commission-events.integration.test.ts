import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { createCreatorCommissionPaymentService } from "@pawket/payments";
import { insertOutboxEvent } from "@pawket/database";
import { createCommissionFileAccessPort, createCommissionOrderService } from "@pawket/orders";
import { createCommissionThreadPort, createCommissionThreadService, encryptCommissionFileName } from "@pawket/commission-files";
import { OUTBOX_JOB, type SystemOutboxJob } from "@pawket/queue";
import { createWorkerJobProcessor } from "../../worker/src/worker-runtime.js";
import { COMMISSION_OUTBOX_EVENTS, validateCommissionOutboxEvent } from "../../worker/src/commission-events.js";
import { commandIds, schema } from "../../../packages/payments/tests/sepay-integration-fixture.js";
import { createCommissionOrderTestFixture } from "./commission-order-test-support.js";

const f = createCommissionOrderTestFixture("commission_events");
beforeAll(f.initialize, 30_000); afterAll(f.dispose, 30_000);

const fulfillmentEvents = ["commission.in_progress.v1", "commission.delivered.v1", "commission.completed.v1",
  "commission.message_sent.v1", "commission.submission_sent.v1", "commission.submission_responded.v1"];
async function fulfillmentJourney() {
  const p = await f.paidOrder(); const at = p.s.creator.now();
  const service = createCommissionOrderService({ ...p.s.input, fulfillmentMode: "enabled",
    thread: createCommissionThreadPort({ keyring: p.s.input.keyring, mode: "enabled" }) });
  const messages = createCommissionThreadService({ ...p.s.creator.common, filesMode: "enabled", fulfillmentMode: "enabled",
    sessions: p.s.input.identity, orders: createCommissionFileAccessPort({ catalog: p.s.catalog }) });
  await messages.sendMessage({ actor: p.buyer, orderId: p.orderId, text: "Synthetic message", fileIds: [], ...commandIds() });
  async function submit(kind: "draft" | "final") {
    const id = randomUUID();
    await f.db.insert(schema.commissionFiles).values({ id, ownerUserId: p.creator.userId, context: "submission", uploadOrderId: p.orderId,
      declaredBytes: 16, filenameEnvelope: encryptCommissionFileName(p.s.input.keyring, id, "Synthetic artwork"), objectKey: `commission/${id}`,
      uploadExpiresAt: new Date(at.getTime() + 900_000), requestId: "fixture", createdAt: at, updatedAt: at });
    await f.db.update(schema.commissionFiles).set({ state: "scanning", uploadedAt: at, scanDeadlineAt: new Date(at.getTime() + 86_400_000), version: 2, updatedAt: at }).where(eq(schema.commissionFiles.id, id));
    await f.db.update(schema.commissionFiles).set({ state: "clean", sha256: `sha256:${"d".repeat(64)}`, detectedType: "png",
      quarantineVersionId: "q", cleanVersionId: "c", cleanAt: at, version: 3, updatedAt: at }).where(eq(schema.commissionFiles.id, id));
    const detail = await service.getOrder({ actor: p.creator, orderId: p.orderId }); const ids = commandIds();
    await service.submit({ actor: p.creator, orderId: p.orderId, expectedVersion: detail.version, kind, note: null, fileIds: [id], ...ids });
    const [submission] = await f.db.select({ id: schema.commissionSubmissions.id }).from(schema.commissionSubmissions).where(eq(schema.commissionSubmissions.requestId, ids.requestId));
    return submission!.id;
  }
  const draftId = await submit("draft");
  await service.respondToSubmission({ actor: p.buyer, orderId: p.orderId, expectedVersion: 2, submissionId: draftId,
    response: "request_changes", note: "Synthetic change request", ...commandIds() });
  const finalId = await submit("final");
  await service.respondToSubmission({ actor: p.buyer, orderId: p.orderId, expectedVersion: 4, submissionId: finalId, response: "accept", note: null, ...commandIds() });
  return p.orderId;
}

test("the worker validates every commission source and replay without a tip email handoff", async () => {
  const s = await f.setup(); const orderId = await s.service.request(s.request());
  const detail = await s.service.getOrder({ actor: s.buyerActor, orderId });
  const claim = { actor: s.buyerActor, orderId, expectedVersion: detail.version, ...commandIds() };
  await s.service.claimTransfer(claim); await s.service.claimTransfer(claim);
  await s.service.claimTransfer({ ...claim, ...commandIds() });
  await createCreatorCommissionPaymentService({ ...s.creator.common, applicationRevision: "synthetic-i6", paymentsMode: "manual_only", recentAuthMs: 900_000,
    mfaAuthMs: 300_000, assurance: s.creator.assurance, commissions: s.service.paymentsLifecycle }).confirm({ actor: s.creator.actor,
    paymentIntentId: detail.payment!.id, observedAmountVnd: detail.payment!.amountVnd, observedTransferReference: detail.payment!.reference,
    observedBankTransactionId: randomUUID(), attestedReceived: true, ...commandIds() });
  const q = await f.setup("custom_quote"); const requestId = await q.service.request(q.request());
  await q.service.quote({ actor: q.creator.actor, orderId: requestId, expectedVersion: 1, terms: q.terms, ttlMs: 86_400_000, ...commandIds() });
  await q.service.close({ actor: q.buyerActor, orderId: requestId, expectedVersion: 2, ...commandIds() });
  await q.catalog.changePackage({ actor: q.creator.actor, packageId: q.packageId, expectedVersion: 2, action: "pause", policyRevisionId: q.policyId, ...commandIds() });
  await q.catalog.changePackage({ actor: q.creator.actor, packageId: q.packageId, expectedVersion: 3, action: "archive", policyRevisionId: q.policyId, ...commandIds() });
  await fulfillmentJourney();
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

test("each fulfillment event rejects changed payloads and sources that disagree with committed facts", async () => {
  const orderId = await fulfillmentJourney();
  const rows = await f.db.select().from(schema.systemOutbox).where(eq(schema.systemOutbox.aggregateId, orderId));
  for (const type of fulfillmentEvents) {
    const row = rows.find((item) => item.eventType === type)!; expect(!!row).toBe(true);
    const event: SystemOutboxJob = { outboxEventId: row.id, eventType: row.eventType, eventVersion: row.eventVersion,
      aggregateType: row.aggregateType, aggregateId: row.aggregateId, payload: row.payload, occurredAt: row.occurredAt.toISOString() };
    await expect(validateCommissionOutboxEvent(f.db, event)).resolves.toBeUndefined();
    const patches = type === "commission.message_sent.v1" ? [{ messageId: randomUUID() }, { sequence: Number(row.payload.sequence) + 1 }] :
      type === "commission.submission_sent.v1" ? [{ submissionId: randomUUID() }, { kind: row.payload.kind === "draft" ? "final" : "draft" }, { sequence: Number(row.payload.sequence) + 1 }] :
      type === "commission.submission_responded.v1" ? [{ submissionId: randomUUID() }, { response: "approved" }] :
      [{ version: Number(row.payload.version) + 100 }, { state: "closed" }, { reason: "buyer_cancelled" }];
    for (const patch of [...patches, { orderId: randomUUID() }, { correlationId: randomUUID() }, { unexpected: true }]) {
      const payload = { ...row.payload, ...patch };
      await expect(validateCommissionOutboxEvent(f.db, { ...event, payload })).rejects.toThrow("Invalid commission worker source");
      // Matching the queue payload to the outbox alone must not suffice.
      const id = await f.db.transaction((tx) => insertOutboxEvent(tx, { eventType: type, eventVersion: 1, aggregateType: row.aggregateType,
        aggregateId: row.aggregateId, payload, occurredAt: row.occurredAt }));
      await expect(validateCommissionOutboxEvent(f.db, { ...event, outboxEventId: id, payload })).rejects.toThrow("Invalid commission worker source");
    }
    const occurredAt = new Date(row.occurredAt.getTime() + 1);
    const id = await f.db.transaction((tx) => insertOutboxEvent(tx, { eventType: type, eventVersion: 1, aggregateType: row.aggregateType,
      aggregateId: row.aggregateId, payload: row.payload, occurredAt }));
    await expect(validateCommissionOutboxEvent(f.db, { ...event, outboxEventId: id, occurredAt: occurredAt.toISOString() })).rejects.toThrow("Invalid commission worker source");
  }
});
