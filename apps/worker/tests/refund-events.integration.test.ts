import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { importConfiguredBusinessCalendarVersion, insertOutboxEvent } from "@pawket/database";
import { createCommissionResolutionOrderPort } from "@pawket/orders";
import { createCommissionPaymentFactsPort, createCommissionRefundPort } from "@pawket/payments";
import { createOwnerResolutionService, createResolutionCommandKit } from "@pawket/resolutions";
import { createTrustCasePort } from "@pawket/trust";
import { OUTBOX_JOB, type SystemOutboxJob } from "@pawket/queue";
import { createCommissionResolutionTestFixture } from "../../web/tests/commission-resolution-test-support.js";
import { commandIds, fixtureKeyring, schema } from "../../../packages/payments/tests/sepay-integration-fixture.js";
import { createWorkerNotificationConfiguration } from "../src/notification-wiring.js";
import { REFUND_OUTBOX_EVENTS, validateRefundOutboxEvent } from "../src/refund-events.js";
import { createWorkerJobProcessor } from "../src/worker-runtime.js";

const f = createCommissionResolutionTestFixture("i9refunds");
const calendarVersion = "vn-i9-refund-events"; const at = new Date("2026-10-09T04:00:00Z");
beforeAll(async () => {
  await f.initialize();
  await f.db.transaction((tx) => importConfiguredBusinessCalendarVersion(tx, { version: calendarVersion, holidayDates: [] }));
}, 60_000);
afterAll(f.dispose, 30_000);
const job = (row: typeof schema.systemOutbox.$inferSelect): SystemOutboxJob => ({ outboxEventId: row.id, eventType: row.eventType,
  eventVersion: row.eventVersion, aggregateType: row.aggregateType, aggregateId: row.aggregateId, payload: row.payload, occurredAt: row.occurredAt.toISOString() });
async function refund() {
  const p = await f.paidOrder(); const port = createCommissionRefundPort({ keyring: p.s.input.keyring, calendarVersion });
  const { obligationId } = await f.db.transaction((tx) => port.createObligation(tx, { orderId: p.orderId, paymentIntentId: p.confirmationCommand.paymentIntentId,
    creatorUserId: p.creator.userId, buyerUserId: p.buyer.userId, source: "agreement", sourceId: randomUUID(), amountVnd: 100_000, requestId: randomUUID(), at }));
  const events = async () => (await f.db.select().from(schema.systemOutbox).where(eq(schema.systemOutbox.eventType, "refund.event_recorded.v1")))
    .filter((row) => row.aggregateId === obligationId);
  return { p, port, obligationId, events };
}
const forge = (row: typeof schema.systemOutbox.$inferSelect, overrides: { payload?: Record<string, unknown>; aggregateId?: string; occurredAt?: Date }) =>
  f.db.transaction((tx) => insertOutboxEvent(tx, { eventType: row.eventType, eventVersion: 1, aggregateType: row.aggregateType, aggregateId: overrides.aggregateId ?? row.aggregateId,
    payload: overrides.payload ?? row.payload, occurredAt: overrides.occurredAt ?? row.occurredAt }));

test("refund events validate against the committed refund event row", async () => {
  expect([...REFUND_OUTBOX_EVENTS]).toEqual(["refund.event_recorded.v1"]);
  const r = await refund(); await f.db.transaction((tx) => r.port.waive(tx, { obligationId: r.obligationId, actor: null, requestId: randomUUID(), at: new Date(at.getTime() + 1_000) }));
  const rows = await r.events(); expect(rows.map((row) => (row.payload as { action: string }).action).sort()).toEqual(["created", "waived"]);
  for (const row of rows) {
    const event = job(row); await expect(validateRefundOutboxEvent(f.db, event)).resolves.toBeUndefined();
    const mismatchedAction = (row.payload as { action: string }).action === "created" ? "waived" : "created";
    const forged = await forge(row, { payload: { ...row.payload, action: mismatchedAction } });
    await expect(validateRefundOutboxEvent(f.db, { ...event, outboxEventId: forged, payload: { ...row.payload, action: mismatchedAction } })).rejects.toThrow("Invalid refund worker source");
    const unknownEvent = { ...row.payload, refundEventId: randomUUID() };
    await expect(validateRefundOutboxEvent(f.db, { ...event, outboxEventId: await forge(row, { payload: unknownEvent }), payload: unknownEvent })).rejects.toThrow("Invalid refund worker source");
    const extra = { ...row.payload, amountVnd: 100_000 };
    await expect(validateRefundOutboxEvent(f.db, { ...event, outboxEventId: await forge(row, { payload: extra }), payload: extra })).rejects.toThrow("Invalid refund worker source");
    const other = await refund(); const foreign = { ...row.payload, obligationId: other.obligationId };
    await expect(validateRefundOutboxEvent(f.db, { ...event, outboxEventId: await forge(row, { payload: foreign }), payload: foreign })).rejects.toThrow("Invalid refund worker source");
    const wrongAggregate = other.obligationId;
    await expect(validateRefundOutboxEvent(f.db, { ...event, outboxEventId: await forge(row, { aggregateId: wrongAggregate }), aggregateId: wrongAggregate })).rejects.toThrow("Invalid refund worker source");
    const occurredAt = new Date(row.occurredAt.getTime() + 1);
    await expect(validateRefundOutboxEvent(f.db, { ...event, outboxEventId: await forge(row, { occurredAt }), occurredAt: occurredAt.toISOString() })).rejects.toThrow("Invalid refund worker source");
    await expect(validateRefundOutboxEvent(f.db, { ...event, eventVersion: 2 })).rejects.toThrow("Invalid refund worker source");
  }
});

test("a refund event naming an action the committed row does not carry is refused by the worker", async () => {
  const r = await refund(); const [row] = await r.events(); const payload = { ...row!.payload, action: "waived" };
  const forged = (await f.db.select().from(schema.systemOutbox).where(eq(schema.systemOutbox.id, await forge(row!, { payload }))))[0]!;
  const acknowledge = vi.fn(async () => true); const logger = { info: vi.fn(), error: vi.fn() };
  const processor = createWorkerJobProcessor({ database: f.db, acknowledge, logger });
  await expect(processor({ id: forged.id, name: OUTBOX_JOB, data: job(forged) } as never)).rejects.toThrow();
  expect(acknowledge).not.toHaveBeenCalled();
  // The genuine row is acknowledged; an unknown refund event type is still refused as before.
  await processor({ id: row!.id, name: OUTBOX_JOB, data: job(row!) } as never);
  expect(acknowledge).toHaveBeenCalledTimes(1);
  await expect(processor({ id: row!.id, name: OUTBOX_JOB, data: { ...job(row!), eventType: "refund.unknown.v1" } } as never)).rejects.toThrow("Unsupported outbox event type");
  expect(acknowledge).toHaveBeenCalledTimes(1);
});

test("a validated refund event materializes its notices after the worker branch", async () => {
  const r = await refund(); const [row] = await r.events();
  const configuration = createWorkerNotificationConfiguration({ NOTIFICATIONS_MODE: "enabled" }, fixtureKeyring);
  const acknowledge = vi.fn(async () => true); const logger = { info: vi.fn(), error: vi.fn() };
  const processor = createWorkerJobProcessor({ database: f.db, acknowledge, logger, notifications: configuration.createMaterializer(f.db) });
  for (let attempt = 0; attempt < 2; attempt += 1) await processor({ id: row!.id, name: OUTBOX_JOB, data: job(row!) } as never);
  expect(acknowledge).toHaveBeenCalledTimes(2); expect(logger.error).not.toHaveBeenCalled();
  const items = await f.db.select().from(schema.notifications).where(inArray(schema.notifications.sourceKey, [row!.id]));
  expect(items.map((item) => [item.kind, item.recipientUserId, item.actionRequired, item.linkPath]).sort()).toEqual([
    ["refund_account_needed", r.p.buyer.userId, true, `/commissions/${r.p.orderId}`],
    ["refund_owed", r.p.creator.userId, false, `/creator/commissions/${r.p.orderId}`],
  ].sort());
});

test("an owner freeze, run through the real services, notifies each affected buyer of the closure and the refund account (P3)", async () => {
  const frozen = await f.paidOrder(); const owner = await frozen.s.buyer();
  const port = { orders: createCommissionResolutionOrderPort({ applicationRevision: "synthetic-i9", newId: randomUUID }),
    refunds: createCommissionRefundPort({ keyring: frozen.s.input.keyring, calendarVersion }), payments: createCommissionPaymentFactsPort(), cases: createTrustCasePort(), mode: "enabled" as const };
  const freeze = createOwnerResolutionService(createResolutionCommandKit({ ...frozen.s.creator.common, session: frozen.s.input.identity, consumeStepUpProof: async () => true }),
    { ...port, applicationRevision: "synthetic-i9", standing: { readCreatorStanding: async () => "suspended" } });
  await freeze.freezeFulfillment({ owner, stepUpProofId: randomUUID(), creatorUserId: frozen.creator.userId, reason: "Synthetic freeze", ...commandIds() });
  const [obligation] = await f.db.select().from(schema.commissionRefundObligations).where(eq(schema.commissionRefundObligations.orderId, frozen.orderId));
  expect(obligation).toMatchObject({ source: "fulfillment_freeze", buyerUserId: frozen.buyer.userId });
  const rows = (await f.db.select().from(schema.systemOutbox)).filter((row) => row.aggregateId === obligation!.id || row.payload.orderId === frozen.orderId
    || (row.eventType === "resolution.fulfillment_frozen.v1" && row.aggregateId === frozen.creator.userId));
  expect(rows.map((row) => row.eventType)).toEqual(expect.arrayContaining(["commission.closed.v1", "refund.event_recorded.v1", "resolution.fulfillment_frozen.v1"]));
  const configuration = createWorkerNotificationConfiguration({ NOTIFICATIONS_MODE: "enabled" }, fixtureKeyring);
  const acknowledge = vi.fn(async () => true); const logger = { info: vi.fn(), error: vi.fn() };
  const processor = createWorkerJobProcessor({ database: f.db, acknowledge, logger, notifications: configuration.createMaterializer(f.db) });
  for (const row of rows) await processor({ id: row.id, name: OUTBOX_JOB, data: job(row) } as never);
  expect(acknowledge).toHaveBeenCalledTimes(rows.length); expect(logger.error).not.toHaveBeenCalled();
  const freezeRows = rows.filter((row) => ["commission.closed.v1", "refund.event_recorded.v1", "resolution.fulfillment_frozen.v1"].includes(row.eventType));
  const items = await f.db.select().from(schema.notifications).where(inArray(schema.notifications.sourceKey, freezeRows.map((row) => row.id)));
  expect(items.filter((item) => item.recipientUserId === frozen.buyer.userId).map((item) => [item.kind, item.variant]).sort()).toEqual([
    ["order_closed", "fulfillment_frozen"], ["refund_account_needed", null],
  ]);
});
