import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { acknowledgeOutboxEvent } from "@pawket/database";
import { SEPAY_EVENT_RECEIVED, readSePayBacklog, resolveSePayWorkerSource } from "@pawket/payments";
import { OUTBOX_JOB, type SystemOutboxJob } from "@pawket/queue";
import { createSePayIntegrationFixture, schema } from "../../../packages/payments/tests/sepay-integration-fixture.js";
import { createWorkerJobProcessor } from "../src/worker-runtime.js";

const fixture = createSePayIntegrationFixture("worker");
beforeAll(fixture.initialize, 30_000);
afterAll(fixture.dispose, 30_000);

async function receipt() {
  const creator = await fixture.creator(); const connection = await creator.connect(); const cutover = await creator.cutover();
  const intent = await creator.createIntent(cutover.id); creator.advance(1_000);
  await creator.inbox.receive(creator.signed(connection.connection.id, connection.secret, creator.event(intent.reference)));
  const [inbox] = await fixture.db.select().from(schema.paymentsSepayInbox).where(eq(schema.paymentsSepayInbox.connectionId, connection.connection.id));
  const [source] = await fixture.db.select().from(schema.systemOutbox).where(and(eq(schema.systemOutbox.aggregateId, inbox!.id), eq(schema.systemOutbox.eventType, SEPAY_EVENT_RECEIVED)));
  const data: SystemOutboxJob = { outboxEventId: source!.id, eventType: source!.eventType, eventVersion: source!.eventVersion,
    aggregateType: source!.aggregateType, aggregateId: source!.aggregateId, payload: source!.payload, occurredAt: source!.occurredAt.toISOString() };
  return { creator, intent, inbox: inbox!, data, job: { id: data.outboxEventId, name: OUTBOX_JOB, data } as never };
}

test("worker resolves persisted source and rejects forged hints before processing or acknowledging", async () => {
  const a = await receipt(); const b = await receipt();
  const processInbox = vi.fn(); const acknowledge = vi.fn();
  const processor = createWorkerJobProcessor({ database: fixture.db, logger: { info: vi.fn(), error: vi.fn() }, acknowledge,
    sepay: { environment: "test", mode: "sepay_optional", service: { processInbox, recoverDue: vi.fn() } } });
  for (const data of [
    { ...a.data, outboxEventId: randomUUID() },
    { ...a.data, aggregateId: b.data.aggregateId, payload: b.data.payload },
    { ...a.data, eventVersion: 2 },
    { ...a.data, aggregateType: "payment_intent" },
    { ...a.data, payload: { inboxId: a.inbox.id, transactionId: "1" } },
    { ...a.data, occurredAt: new Date(0).toISOString() },
  ]) await expect(processor({ id: data.outboxEventId, name: OUTBOX_JOB, data } as never)).rejects.toThrow("Worker job processing failed");
  expect(processInbox).not.toHaveBeenCalled(); expect(acknowledge).not.toHaveBeenCalled();
  await expect(resolveSePayWorkerSource(fixture.db, a.data, "live")).rejects.toThrow("Invalid SePay worker source");
  await expect(resolveSePayWorkerSource(fixture.db, a.data, "test")).resolves.toBe(a.inbox.id);
});

test.each(["disabled", "manual_only"] as const)("%s acknowledges a durable hint without processing and preserves DB recovery", async (mode) => {
  const row = await receipt(); const processInbox = vi.fn();
  const processor = createWorkerJobProcessor({ database: fixture.db, logger: { info: vi.fn(), error: vi.fn() }, acknowledge: acknowledgeOutboxEvent,
    sepay: { environment: "test", mode, service: { processInbox, recoverDue: vi.fn() } } });
  await processor(row.job);
  expect(processInbox).not.toHaveBeenCalled();
  const [state] = await fixture.db.select().from(schema.paymentsSepayProcessing).where(eq(schema.paymentsSepayProcessing.inboxId, row.inbox.id));
  const [source] = await fixture.db.select().from(schema.systemOutbox).where(eq(schema.systemOutbox.id, row.data.outboxEventId));
  expect(state).toMatchObject({ status: "pending", attempts: 0 }); expect(source!.publishedAt).not.toBeNull();
  // Recovery reads PostgreSQL even though the delivery hint was already acknowledged.
  await expect(row.creator.reconciliation.recoverDue(100)).resolves.toBeGreaterThanOrEqual(1);
  expect((await fixture.db.select().from(schema.paymentIntents).where(eq(schema.paymentIntents.id, row.intent.id)))[0]!.state).toBe("confirmed");
});

test("acknowledgement response loss redelivers one committed confirmation and business outbox", async () => {
  const row = await receipt(); const logger = { info: vi.fn(), error: vi.fn() }; let fail = true;
  const processor = createWorkerJobProcessor({ database: fixture.db, logger,
    acknowledge: async (db, command) => { if (fail) { fail = false; throw new Error("private synthetic provider detail"); } return acknowledgeOutboxEvent(db, command); },
    sepay: { environment: "test", mode: "sepay_optional", service: row.creator.reconciliation } });
  await expect(processor(row.job)).rejects.toThrow("Worker job processing failed");
  await expect(processor(row.job)).resolves.toBeUndefined();
  expect(await fixture.db.select().from(schema.paymentConfirmations).where(eq(schema.paymentConfirmations.paymentIntentId, row.intent.id))).toHaveLength(1);
  expect(await fixture.db.select().from(schema.systemOutbox).where(and(eq(schema.systemOutbox.aggregateId, row.intent.id), eq(schema.systemOutbox.eventType, "tip.confirmed.v1")))).toHaveLength(1);
  expect(JSON.stringify(logger.error.mock.calls)).not.toContain("private synthetic provider detail");
  const backlog = await readSePayBacklog(fixture.db, "test", row.creator.now());
  expect(Object.keys(backlog).sort()).toEqual(["oldestAgeSeconds", "pending", "reviewRequired"]);
});
