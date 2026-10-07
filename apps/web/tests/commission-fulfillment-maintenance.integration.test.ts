import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createCommissionThreadPort, encryptCommissionFileName } from "@pawket/commission-files";
import { createCommissionOrderMaintenanceService, createCommissionOrderService } from "@pawket/orders";
import { commandIds, schema } from "../../../packages/payments/tests/sepay-integration-fixture.js";
import { createCommissionOrderTestFixture } from "./commission-order-test-support.js";

let f: ReturnType<typeof createCommissionOrderTestFixture>;
// Each test owns a schema: global pauses and held candidates cannot affect later tests.
beforeEach(async () => { f = createCommissionOrderTestFixture("i7maintenance"); await f.initialize(); }, 60_000);
afterEach(async () => { await f.dispose(); }, 30_000);
const HOUR = 3_600_000; const DAY = 24 * HOUR;
type Paid = Awaited<ReturnType<typeof f.paidOrder>>;
type MaintenanceOptions = Partial<Parameters<typeof createCommissionOrderMaintenanceService>[0]>;
const order = (p: Paid) => f.db.select().from(schema.commissionOrders).where(eq(schema.commissionOrders.id, p.orderId)).then((rows) => rows[0]!);
const reservation = (p: Paid) => f.db.select().from(schema.commissionReservations).where(eq(schema.commissionReservations.orderId, p.orderId)).then((rows) => rows[0]!);
const events = (p: Paid) => f.db.select().from(schema.commissionEvents).where(eq(schema.commissionEvents.orderId, p.orderId));
const service = (p: Paid) => createCommissionOrderService({ ...p.s.input, fulfillmentMode: "enabled",
  thread: createCommissionThreadPort({ keyring: p.s.input.keyring, mode: "enabled" }) });
const maintenance = (p: Paid, options: MaintenanceOptions = {}) => createCommissionOrderMaintenanceService({ ...p.s.input, ...options });
async function delivered(delayMs = 0) {
  const p = await f.paidOrder(); p.s.creator.advance(delayMs); const at = p.s.creator.now(); const fileId = randomUUID();
  await f.db.insert(schema.commissionFiles).values({ id: fileId, ownerUserId: p.creator.userId, context: "submission", uploadOrderId: p.orderId,
    declaredBytes: 16, filenameEnvelope: encryptCommissionFileName(p.s.input.keyring, fileId, "Synthetic artwork"), objectKey: `commission/${fileId}`,
    uploadExpiresAt: new Date(at.getTime() + 900_000), requestId: "fixture", createdAt: at, updatedAt: at });
  await f.db.update(schema.commissionFiles).set({ state: "scanning", uploadedAt: at, scanDeadlineAt: new Date(at.getTime() + DAY), version: 2, updatedAt: at }).where(eq(schema.commissionFiles.id, fileId));
  await f.db.update(schema.commissionFiles).set({ state: "clean", sha256: `sha256:${"d".repeat(64)}`, detectedType: "png", quarantineVersionId: "q",
    cleanVersionId: "c", cleanAt: at, version: 3, updatedAt: at }).where(eq(schema.commissionFiles.id, fileId));
  await service(p).submit({ actor: p.creator, orderId: p.orderId, expectedVersion: (await order(p)).version,
    kind: "final", note: undefined, fileIds: [fileId], ...commandIds() });
  const [final] = await f.db.select().from(schema.commissionSubmissions).where(eq(schema.commissionSubmissions.orderId, p.orderId));
  return { ...p, finalId: final!.id };
}
async function accept(p: Paid & { finalId: string }, expectedVersion = 3) {
  return service(p).respondToSubmission({ actor: p.buyer, orderId: p.orderId, submissionId: p.finalId,
    expectedVersion, response: "accept", note: undefined, ...commandIds() });
}

test("due orders complete automatically and free the slot", async () => {
  const p = await delivered(); const due = (await order(p)).reviewEndsAt!; p.s.creator.setNow(due);
  const instance = maintenance(p); const beforePayments = await f.db.select().from(schema.paymentIntents);
  expect(await instance.completeDue()).toEqual({ scanned: 1, completed: 1, held: 0, waiting: 0, nextAfter: null });
  expect(await order(p)).toMatchObject({ state: "completed", completionKind: "review_window_elapsed", completedAt: due, updatedAt: due, version: 4 });
  expect(await reservation(p)).toMatchObject({ state: "completed", releasedAt: due });
  expect((await events(p)).filter((row) => row.type === "completed")).toMatchObject([{ reason: "review_window_elapsed", actorUserId: null, actorSessionId: null, occurredAt: due }]);
  const [completion] = (await events(p)).filter((row) => row.type === "completed");
  expect(completion!.requestId).toMatch(/^commission-completion:[0-9a-f-]{36}$/u);
  expect((await f.db.select().from(schema.systemOutbox).where(eq(schema.systemOutbox.aggregateId, p.orderId))).filter((row) => row.eventType === "commission.completed.v1")).toHaveLength(1);
  expect(await f.db.select().from(schema.paymentIntents)).toEqual(beforePayments);
  expect(await instance.completeDue()).toMatchObject({ scanned: 0, completed: 0 });
  expect((await p.s.catalog.getWorkspace(p.creator)).settings.used).toBe(0);
});
test("not yet due is untouched", async () => {
  const p = await delivered(); p.s.creator.setNow(new Date((await order(p)).reviewEndsAt!.getTime() - 1));
  const before = [await order(p), await reservation(p), await events(p)];
  expect(await maintenance(p).completeDue()).toEqual({ scanned: 0, completed: 0, held: 0, waiting: 0, nextAfter: null });
  expect([await order(p), await reservation(p), await events(p)]).toEqual(before);
});
test("a held order is counted held and stays delivered", async () => {
  const p = await delivered(); p.s.creator.setNow((await order(p)).reviewEndsAt!);
  const hold = vi.fn(async () => true); const before = await order(p);
  expect(await maintenance(p, { holds: { hasOpenDispute: async () => false, hasActiveCompletionHold: hold } }).completeDue()).toEqual({ scanned: 1, completed: 0, held: 1, waiting: 0, nextAfter: null });
  expect(hold).toHaveBeenCalledTimes(1); expect(hold.mock.calls[0]).toHaveLength(2);
  expect(await order(p)).toEqual(before); expect((await reservation(p)).state).toBe("occupied");
});
test("an open pause covering the deadline means waiting", async () => {
  const p = await delivered(); const instance = maintenance(p); const due = (await order(p)).reviewEndsAt!;
  p.s.creator.setNow(new Date(due.getTime() - HOUR)); await instance.observeFulfillmentMode("disabled");
  p.s.creator.setNow(due); const before = await order(p); const hold = vi.fn(async () => false);
  expect(await maintenance(p, { holds: { hasOpenDispute: async () => false, hasActiveCompletionHold: hold } }).completeDue()).toEqual({ scanned: 1, completed: 0, held: 0, waiting: 1, nextAfter: null });
  expect(hold).not.toHaveBeenCalled(); expect(await order(p)).toEqual(before);
  await instance.observeFulfillmentMode("enabled");
});
test("after resume, completion waits 48 h", async () => {
  const p = await delivered(); const instance = maintenance(p); const due = (await order(p)).reviewEndsAt!;
  p.s.creator.setNow(new Date(due.getTime() - HOUR)); await instance.observeFulfillmentMode("disabled");
  const resumed = new Date(due.getTime() + DAY); p.s.creator.setNow(resumed); await instance.observeFulfillmentMode("enabled");
  p.s.creator.setNow(new Date(resumed.getTime() + 48 * HOUR - 1));
  expect(await instance.completeDue()).toMatchObject({ completed: 0, waiting: 1 });
  const graceEnd = new Date(resumed.getTime() + 48 * HOUR); p.s.creator.setNow(graceEnd);
  expect(await instance.completeDue()).toMatchObject({ completed: 1, waiting: 0 });
  expect((await order(p)).completedAt).toEqual(graceEnd);
});
test("held and waiting orders do not starve later ones", async () => {
  const orders = await Promise.all([delivered(), delivered(), delivered()]);
  orders.sort((a, b) => a.orderId.localeCompare(b.orderId)); const due = (await order(orders[0]!)).reviewEndsAt!;
  const instance = maintenance(orders[0]!, { now: () => due, holds: { hasOpenDispute: async () => false, hasActiveCompletionHold: async (_tx, id) => id === orders[0]!.orderId } });
  const first = await instance.completeDue({ limit: 1 }); expect(first).toMatchObject({ scanned: 1, completed: 0, held: 1, waiting: 0, nextAfter: { id: orders[0]!.orderId, reviewEndsAt: due } });
  const second = await instance.completeDue({ limit: 1, after: first.nextAfter }); expect(second).toMatchObject({ scanned: 1, completed: 1, nextAfter: { id: orders[1]!.orderId } });
  const third = await instance.completeDue({ limit: 1, after: second.nextAfter }); expect(third).toMatchObject({ scanned: 1, completed: 1, nextAfter: { id: orders[2]!.orderId } });
  expect(await instance.completeDue({ limit: 1, after: third.nextAfter })).toEqual({ scanned: 0, completed: 0, held: 0, waiting: 0, nextAfter: null });
  const paused = maintenance(orders[0]!, { now: () => new Date(due.getTime() - 1) }); await paused.observeFulfillmentMode("disabled");
  const waiting = await instance.completeDue({ limit: 1 }); expect(waiting).toMatchObject({ waiting: 1, held: 0, nextAfter: { id: orders[0]!.orderId } });
  expect(await instance.completeDue({ limit: 1, after: waiting.nextAfter })).toMatchObject({ scanned: 0, nextAfter: null });
  await paused.observeFulfillmentMode("enabled");
});
test("a waiting grace deadline does not starve later review deadlines", async () => {
  const firstOrder = await delivered(); const secondOrder = await delivered(HOUR); const thirdOrder = await delivered(2 * HOUR);
  const due = (await order(firstOrder)).reviewEndsAt!; const pause = maintenance(firstOrder);
  firstOrder.s.creator.setNow(new Date(due.getTime() - 1)); await pause.observeFulfillmentMode("disabled");
  firstOrder.s.creator.setNow(new Date(due.getTime() + 1)); await pause.observeFulfillmentMode("enabled");
  const instance = maintenance(firstOrder, { now: () => new Date(due.getTime() + 2 * HOUR) });
  const first = await instance.completeDue({ limit: 1 });
  expect(first).toMatchObject({ scanned: 1, completed: 0, held: 0, waiting: 1, nextAfter: { reviewEndsAt: due, id: firstOrder.orderId } });
  const second = await instance.completeDue({ limit: 1, after: first.nextAfter });
  expect(second).toMatchObject({ scanned: 1, completed: 1, waiting: 0, nextAfter: { id: secondOrder.orderId } });
  const third = await instance.completeDue({ limit: 1, after: second.nextAfter });
  expect(third).toMatchObject({ scanned: 1, completed: 1, waiting: 0, nextAfter: { id: thirdOrder.orderId } });
  expect((await order(firstOrder)).state).toBe("delivered");
  expect(await instance.completeDue({ limit: 1, after: third.nextAfter })).toMatchObject({ scanned: 0, nextAfter: null });
});
test("automatic completion racing buyer acceptance: exactly one result", async () => {
  const p = await delivered(); const due = (await order(p)).reviewEndsAt!; p.s.creator.setNow(new Date(due.getTime() - 1));
  // Separate valid command clocks overlap at the boundary; both contend for the creator fence.
  await f.client`create table completion_transition_count (total integer not null)`;
  await f.client`insert into completion_transition_count values (0)`;
  await f.client`create function count_completion_transition() returns trigger language plpgsql as $$
    begin update completion_transition_count set total = total + 1; return NEW; end $$`;
  await f.client`create trigger count_completion_transition after update on commission_reservations
    for each row when (OLD.state = 'occupied' and NEW.state = 'completed') execute function count_completion_transition()`;
  const [automatic, buyer] = await Promise.allSettled([maintenance(p, { now: () => due }).completeDue(), accept(p)]);
  expect(automatic.status).toBe("fulfilled");
  const automaticCount = automatic.status === "fulfilled" ? automatic.value.completed : 0;
  expect(automaticCount + Number(buyer.status === "fulfilled")).toBe(1);
  if (buyer.status === "rejected") expect(["version_conflict", "invalid_transition"]).toContain(buyer.reason.code);
  const current = await order(p); const slot = await reservation(p);
  expect(current).toMatchObject({ state: "completed", version: 4 }); expect(slot).toMatchObject({ state: "completed", releasedAt: current.completedAt });
  expect((await events(p)).filter((row) => row.type === "completed")).toHaveLength(1);
  expect((await f.client`select total from completion_transition_count`)[0]!.total).toBe(1);
});
test("observeFulfillmentMode opens and closes one pause", async () => {
  const p = await f.paidOrder(); const instance = maintenance(p); const startedAt = p.s.creator.now();
  expect(await instance.observeFulfillmentMode("enabled")).toEqual({ change: "none", paused: false });
  expect(await instance.observeFulfillmentMode("disabled")).toEqual({ change: "opened", paused: true });
  p.s.creator.advance(HOUR); const endedAt = p.s.creator.now();
  expect(await instance.observeFulfillmentMode("enabled")).toEqual({ change: "closed", paused: false });
  const rows = await f.db.select().from(schema.commissionFulfillmentPauses); expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ startedAt, endedAt });
});
test("repeated observations are idempotent", async () => {
  const p = await f.paidOrder(); const instance = maintenance(p);
  const opened = await Promise.all([instance.observeFulfillmentMode("disabled"), instance.observeFulfillmentMode("disabled")]);
  expect(opened.map((row) => row.change).sort()).toEqual(["none", "opened"]); expect(opened.every((row) => row.paused)).toBe(true);
  const before = await f.db.select().from(schema.commissionFulfillmentPauses); p.s.creator.advance(HOUR);
  expect(await instance.observeFulfillmentMode("disabled")).toEqual({ change: "none", paused: true });
  expect(await f.db.select().from(schema.commissionFulfillmentPauses)).toEqual(before);
  const closed = await Promise.all([instance.observeFulfillmentMode("enabled"), instance.observeFulfillmentMode("enabled")]);
  expect(closed.map((row) => row.change).sort()).toEqual(["closed", "none"]); expect(closed.every((row) => !row.paused)).toBe(true);
  expect(await f.db.select().from(schema.commissionFulfillmentPauses)).toHaveLength(1);
});
test("I6 maintenance ignores delivered and completed orders", async () => {
  const deliveredOrder = await delivered(); const completedOrder = await delivered(); await accept(completedOrder);
  const before = await Promise.all([order(deliveredOrder), order(completedOrder), reservation(deliveredOrder), reservation(completedOrder), events(deliveredOrder), events(completedOrder)]);
  const participants = vi.fn(async () => false); const instance = maintenance(deliveredOrder, { now: () => new Date("2027-01-01T00:00Z"), identity: { lockSettlementParticipants: participants } });
  expect(await instance.expireDue()).toEqual({ scanned: 0, expired: 0 });
  expect(await instance.recoverInvalidations()).toEqual({ scanned: 0, invalidated: 0, deferred: 0, nextAfterId: null });
  expect(participants).not.toHaveBeenCalled();
  expect(await Promise.all([order(deliveredOrder), order(completedOrder), reservation(deliveredOrder), reservation(completedOrder), events(deliveredOrder), events(completedOrder)])).toEqual(before);
});
