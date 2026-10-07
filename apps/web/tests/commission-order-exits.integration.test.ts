import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { COMMISSION_POST_PAYMENT_CLOSE_REASONS } from "@pawket/database";
import { createCommissionThreadService } from "@pawket/commission-files";
import { createCommissionFileAccessPort, createCommissionResolutionOrderPort, type CommissionIntakeFencePort } from "@pawket/orders";
import { createCreatorCommissionPaymentService } from "@pawket/payments";
import { validateCommissionOutboxEvent } from "../../worker/src/commission-events.js";
import { createCommissionResolutionTestFixture, service, submit, submitCommand, respond } from "./commission-resolution-test-support.js";
import { commandIds, fixtureHash, schema } from "../../../packages/payments/tests/sepay-integration-fixture.js";

let f: ReturnType<typeof createCommissionResolutionTestFixture>;
// Completion scans and pause history are schema-global; each test owns its schema.
beforeEach(async () => { f = createCommissionResolutionTestFixture("i8exits"); await f.initialize(); }, 60_000);
afterEach(async () => { await f.dispose(); }, 30_000);
const DAY = 86_400_000;
type Paid = Awaited<ReturnType<typeof f.paidOrder>>;
const port = () => createCommissionResolutionOrderPort({ applicationRevision: "synthetic-i8", newId: randomUUID });
const order = (p: Paid) => f.db.select().from(schema.commissionOrders).where(eq(schema.commissionOrders.id, p.orderId)).then((rows) => rows[0]!);
const reservation = (p: Paid) => f.db.select().from(schema.commissionReservations).where(eq(schema.commissionReservations.orderId, p.orderId)).then((rows) => rows[0]!);
const history = (p: Paid) => f.db.select().from(schema.commissionEvents).where(eq(schema.commissionEvents.orderId, p.orderId));
async function paymentFacts(p: Paid) {
  const intentId = p.confirmationCommand.paymentIntentId;
  return { intent: (await f.db.select().from(schema.paymentIntents).where(eq(schema.paymentIntents.id, intentId)))[0]!,
    confirmations: await f.db.select().from(schema.paymentConfirmations).where(eq(schema.paymentConfirmations.paymentIntentId, intentId)) };
}
async function resolutionCommand(p: Paid) {
  return { orderId: p.orderId, expectedVersion: (await order(p)).version, actor: p.buyer, requestId: randomUUID(), at: p.s.creator.now() };
}
async function restore(p: Paid, floorAt: Date) {
  const command = { ...await resolutionCommand(p), floorAt };
  return f.db.transaction((tx) => port().restoreReviewTime(tx, command));
}
async function close(p: Paid, reason: typeof COMMISSION_POST_PAYMENT_CLOSE_REASONS[number] = "cancelled_by_agreement") {
  const command = { ...await resolutionCommand(p), reason };
  return f.db.transaction((tx) => port().closePaidOrder(tx, command));
}
const pausedFence = (): CommissionIntakeFencePort => ({ isIntakePaused: async () => true, describe: async () => ({ paused: true, overdue: [] }) });

describe("commission resolution order port", () => {
  test.each(COMMISSION_POST_PAYMENT_CLOSE_REASONS)("closePaidOrder with %s cancels the reservation, writes a closed event and keeps the payment confirmed", async (reason) => {
    const p = await f.paidOrder(); const before = await order(p); const payments = await paymentFacts(p); p.s.creator.advance(1_000);
    expect(await close(p, reason)).toEqual({ version: before.version + 1 });
    expect(await order(p)).toMatchObject({ state: "closed", closeReason: reason, closedAt: p.s.creator.now(), confirmedAt: before.confirmedAt, dueAt: before.dueAt });
    expect(await reservation(p)).toMatchObject({ state: "cancelled", releasedAt: p.s.creator.now() });
    expect((await history(p)).filter((row) => row.type === "closed")).toMatchObject([{ reason, orderVersion: before.version + 1 }]);
    expect((await paymentFacts(p)).intent.state).toBe("confirmed");
    expect(await paymentFacts(p)).toEqual(payments);
    const [outbox] = await f.db.select().from(schema.systemOutbox).where(and(eq(schema.systemOutbox.aggregateId, p.orderId), eq(schema.systemOutbox.eventType, "commission.closed.v1")));
    expect(outbox!.payload).toEqual({ orderId: p.orderId, version: before.version + 1, state: "closed", reason, correlationId: expect.any(String) });
    const [audit] = await f.db.select().from(schema.adminAuditEvents).where(and(eq(schema.adminAuditEvents.subjectId, p.orderId), eq(schema.adminAuditEvents.action, "commission.closed")));
    expect(audit!.afterState).toEqual({ state: "closed", version: before.version + 1, reason });
    await expect(close(p, reason)).rejects.toMatchObject({ code: "invalid_transition" });
  });
  test("a delivered paid close keeps delivery facts and creator-visible brief references", async () => {
    const p = await f.deliveredOrder(); const before = await order(p);
    const files = { attachBriefFiles: vi.fn(), describeBriefFiles: vi.fn(async () => []) };
    await close(p);
    expect(await order(p)).toMatchObject({ deliveredAt: before.deliveredAt, reviewEndsAt: before.reviewEndsAt });
    await service(p, { files }).getOrder({ actor: p.creator, orderId: p.orderId });
    expect(files.describeBriefFiles).toHaveBeenCalledWith(expect.anything(), { orderId: p.orderId, viewer: "creator", withdrawn: false });
  });
  test.each(["agreement", "ruling"] as const)("completeByResolution completes a delivered order with kind %s", async (kind) => {
    const p = await f.deliveredOrder(); const command = { ...await resolutionCommand(p), kind }; const payments = await paymentFacts(p);
    expect(await f.db.transaction((tx) => port().completeByResolution(tx, command))).toEqual({ version: command.expectedVersion + 1 });
    expect(await order(p)).toMatchObject({ state: "completed", completionKind: kind, completedAt: command.at });
    expect(await reservation(p)).toMatchObject({ state: "completed", releasedAt: command.at });
    expect((await history(p)).filter((row) => row.type === "completed")).toMatchObject([{ reason: kind }]);
    expect(await paymentFacts(p)).toEqual(payments);
  });
  test("completeByResolution on in_progress fails invalid_transition", async () => {
    const p = await f.paidOrder(); const before = await order(p); const command = { ...await resolutionCommand(p), kind: "agreement" as const };
    await expect(f.db.transaction((tx) => port().completeByResolution(tx, command))).rejects.toMatchObject({ code: "invalid_transition" });
    expect(await order(p)).toEqual(before); expect((await reservation(p)).state).toBe("occupied");
  });
  test("restoreReviewTime moves completionDueAt and buyer accept stays open until the floor", async () => {
    const p = await f.deliveredOrder(); const before = await order(p); const floor = new Date(before.reviewEndsAt!.getTime() + 2 * DAY);
    expect(await restore(p, floor)).toEqual({ version: before.version + 1 });
    expect(await f.db.transaction((tx) => port().completionDueAt(tx, p.orderId))).toEqual(floor);
    expect((await service(p).getOrder({ actor: p.buyer, orderId: p.orderId })).fulfillment).toMatchObject({ completionFloorAt: floor.toISOString(), completionDueAt: floor.toISOString() });
    p.s.creator.setNow(new Date(before.reviewEndsAt!.getTime() + DAY));
    await expect(respond(p, p.finalId, "accept")).resolves.toBe(p.orderId);
    expect((await order(p)).completionKind).toBe("buyer_accepted");
  });
  test("restoreReviewTime records a delivered review_time_restored event the worker accepts", async () => {
    const p = await f.deliveredOrder(); const before = await order(p); await restore(p, new Date(before.reviewEndsAt!.getTime() + 2 * DAY));
    expect((await history(p)).filter((row) => row.reason === "review_time_restored")).toMatchObject([{ type: "delivered", orderVersion: before.version + 1 }]);
    const events = await f.db.select().from(schema.systemOutbox).where(eq(schema.systemOutbox.aggregateId, p.orderId));
    const restored = events.find((event) => event.payload.reason === "review_time_restored")!;
    expect(!!restored).toBe(true);
    await expect(validateCommissionOutboxEvent(f.db, { outboxEventId: restored.id, eventType: restored.eventType, eventVersion: restored.eventVersion,
      aggregateType: restored.aggregateType, aggregateId: restored.aggregateId, payload: restored.payload, occurredAt: restored.occurredAt.toISOString() })).resolves.toBeUndefined();
  });
  test("restoreReviewTime is a no-op at or before the current base and rejects stale versions", async () => {
    const p = await f.deliveredOrder(); const review = (await order(p)).reviewEndsAt!;
    for (const floor of [new Date(review.getTime() - DAY), review]) expect(await restore(p, floor)).toEqual({ version: 3 });
    const floor = new Date(review.getTime() + 2 * DAY); await restore(p, floor);
    const before = await order(p); const events = await history(p);
    const outbox = await f.db.select().from(schema.systemOutbox).where(eq(schema.systemOutbox.aggregateId, p.orderId));
    for (const candidate of [review, new Date(floor.getTime() - 1), floor]) expect(await restore(p, candidate)).toEqual({ version: before.version });
    expect(await order(p)).toEqual(before); expect(await history(p)).toEqual(events);
    expect(await f.db.select().from(schema.systemOutbox).where(eq(schema.systemOutbox.aggregateId, p.orderId))).toEqual(outbox);
    const command = { ...await resolutionCommand(p), expectedVersion: before.version - 1, floorAt: floor };
    await expect(f.db.transaction((tx) => port().restoreReviewTime(tx, command))).rejects.toMatchObject({ code: "version_conflict" });
  });
  test("changes requested clears the floor", async () => {
    const p = await f.deliveredOrder(); await restore(p, new Date((await order(p)).reviewEndsAt!.getTime() + 2 * DAY));
    await respond(p, p.finalId, "request_changes");
    expect(await order(p)).toMatchObject({ state: "in_progress", completionFloorAt: null, deliveredAt: null, reviewEndsAt: null });
    expect(await f.db.transaction((tx) => port().completionDueAt(tx, p.orderId))).toBeNull();
  });
  test("automatic completion waits for the floor", async () => {
    const p = await f.deliveredOrder(); const review = (await order(p)).reviewEndsAt!; const floor = new Date(review.getTime() + 2 * DAY);
    await restore(p, floor); p.s.creator.setNow(new Date(review.getTime() + DAY));
    expect(await service(p).completeDue()).toMatchObject({ scanned: 1, completed: 0, held: 0, waiting: 1 });
    expect((await order(p)).state).toBe("delivered");
    p.s.creator.setNow(floor); expect(await service(p).completeDue()).toMatchObject({ completed: 1, waiting: 0 });
  });
  test("restored floors remain subject to fulfillment pause grace and buyer expiry", async () => {
    const p = await f.deliveredOrder(); const review = (await order(p)).reviewEndsAt!; const floor = new Date(review.getTime() + 2 * DAY); await restore(p, floor);
    const resumedAt = new Date(floor.getTime() + DAY); const pauseId = randomUUID();
    await f.db.insert(schema.commissionFulfillmentPauses).values({ id: pauseId, startedAt: new Date(floor.getTime() - 1) });
    try { expect(await f.db.transaction((tx) => port().completionDueAt(tx, p.orderId))).toBeNull(); }
    finally { await f.db.update(schema.commissionFulfillmentPauses).set({ endedAt: resumedAt }).where(eq(schema.commissionFulfillmentPauses.id, pauseId)); }
    const due = new Date(resumedAt.getTime() + 2 * DAY);
    expect(await f.db.transaction((tx) => port().completionDueAt(tx, p.orderId))).toEqual(due);
    p.s.creator.setNow(due); await expect(respond(p, p.finalId, "accept")).rejects.toMatchObject({ code: "expired" });
  });
  test("lockOrder returns resolution facts and listLiveOrders excludes terminal orders", async () => {
    const p = await f.deliveredOrder(); const before = await order(p);
    const facts = await f.db.transaction((tx) => port().lockOrder(tx, p.orderId));
    expect(facts).toEqual({ id: p.orderId, version: before.version, state: "delivered", creatorUserId: p.creator.userId, buyerUserId: p.buyer.userId, amountVnd: before.amountVnd,
      acceptedAt: before.acceptedAt, confirmedAt: before.confirmedAt, dueAt: before.dueAt, deliveredAt: before.deliveredAt, reviewEndsAt: before.reviewEndsAt,
      completionFloorAt: null, closedAt: null, closeReason: null, policyRevisionId: p.s.policyId });
    expect(await f.db.transaction((tx) => port().listLiveOrders(tx, p.creator.userId))).toEqual([{ orderId: p.orderId, version: before.version }]);
    await close(p); expect(await f.db.transaction((tx) => port().listLiveOrders(tx, p.creator.userId))).toEqual([]);
    expect(await f.db.transaction((tx) => port().lockOrder(tx, randomUUID()))).toBeNull();
  });
  test("a confirmation attempt after a paid close behaves as it does for an in_progress order", async () => {
    const live = await f.paidOrder(); const liveBefore = await order(live); const livePayments = await paymentFacts(live);
    const outcome = await live.confirmationService.confirm({ ...live.confirmationCommand, ...commandIds() }).then(() => "confirmed", (error: { code: string }) => error.code);
    expect(outcome).toBe("intent_not_pending"); expect(await order(live)).toEqual(liveBefore); expect(await paymentFacts(live)).toEqual(livePayments);
    const p = await f.paidOrder(); await close(p); const before = await order(p); const payments = await paymentFacts(p);
    const closedOutcome = await p.confirmationService.confirm({ ...p.confirmationCommand, ...commandIds() }).then(() => "confirmed", (error: { code: string }) => error.code);
    expect(closedOutcome).toBe(outcome); expect(await order(p)).toEqual(before); expect(await paymentFacts(p)).toEqual(payments);
    // A true idempotency replay must still return the confirmed projection.
    expect((await p.confirmationService.confirm(p.confirmationCommand)).state).toBe("confirmed");
    expect(await order(p)).toEqual(before); expect(await paymentFacts(p)).toEqual(payments);
  });
});

test("an open dispute blocks submissions and change requests with dispute_open; messages are unaffected", async () => {
  const p = await f.paidOrder(); const draft = await submit(p); const holds = { hasActiveCompletionHold: async () => true, hasOpenDispute: vi.fn(async () => true) };
  const instance = service(p, { holds }); const before = await order(p);
  for (const kind of ["draft", "final"] as const) await expect(instance.submit(await submitCommand(p, kind))).rejects.toMatchObject({ code: "dispute_open" });
  for (const response of ["approve", "request_changes"] as const) await expect(respond(p, draft.id, response, instance)).rejects.toMatchObject({ code: "dispute_open" });
  const final = await submit(p, "final");
  await expect(respond(p, final.id, "request_changes", instance)).rejects.toMatchObject({ code: "dispute_open" });
  await expect(respond(p, final.id, "accept", instance)).rejects.toMatchObject({ code: "completion_held" });
  const messages = createCommissionThreadService({ ...p.s.input, filesMode: "enabled", fulfillmentMode: "enabled", sessions: p.s.input.identity,
    orders: createCommissionFileAccessPort({ catalog: p.s.catalog }) });
  await expect(messages.sendMessage({ actor: p.buyer, orderId: p.orderId, text: "Synthetic message", fileIds: [], ...commandIds() })).resolves.toMatchObject({ messageId: expect.any(String) });
  expect((await order(p)).version).toBe(before.version + 1); expect(holds.hasOpenDispute).toHaveBeenCalledTimes(5);
});

test("intake fence refuses request, quote and accept with intake_paused; an issued payment intent still confirms", async () => {
  const gates = { paused: false }; const fence: CommissionIntakeFencePort = { isIntakePaused: async () => gates.paused, describe: async () => ({ paused: gates.paused, overdue: [] }) };
  const fixed = await f.setup("fixed_approval", { intakeFence: fence }); const fixedId = await fixed.service.request(fixed.request());
  const custom = await f.setup("custom_quote", { intakeFence: fence }); const customId = await custom.service.request(custom.request());
  await custom.service.quote({ actor: custom.creator.actor, orderId: customId, expectedVersion: 1, terms: custom.terms, ttlMs: DAY, ...commandIds() });
  const pending = await f.setup("fixed_immediate", { intakeFence: fence }); const pendingId = await pending.service.request(pending.request());
  const payment = (await pending.service.getOrder({ actor: pending.buyerActor, orderId: pendingId })).payment!; gates.paused = true;
  for (const s of [fixed, custom, pending]) await expect(s.service.request(s.request())).rejects.toMatchObject({ code: "intake_paused" });
  await expect(custom.service.quote({ actor: custom.creator.actor, orderId: customId, expectedVersion: 2, terms: custom.terms, ttlMs: DAY, ...commandIds() })).rejects.toMatchObject({ code: "intake_paused" });
  await expect(fixed.service.accept({ actor: fixed.creator.actor, orderId: fixedId, expectedVersion: 1, quoteRevisionId: null, policyRevisionId: fixed.policyId, acceptTerms: true, abuseKeyHash: fixtureHash(), ...commandIds() })).rejects.toMatchObject({ code: "intake_paused" });
  const quote = (await custom.service.getOrder({ actor: custom.buyerActor, orderId: customId })).quote!;
  await expect(custom.service.accept({ actor: custom.buyerActor, orderId: customId, expectedVersion: 2, quoteRevisionId: quote.id, policyRevisionId: custom.policyId, acceptTerms: true, abuseKeyHash: fixtureHash(), ...commandIds() })).rejects.toMatchObject({ code: "intake_paused" });
  const payments = createCreatorCommissionPaymentService({ ...pending.creator.common, applicationRevision: "synthetic-i8", paymentsMode: "manual_only", recentAuthMs: 900_000, mfaAuthMs: 300_000,
    assurance: pending.creator.assurance, commissions: pending.service.paymentsLifecycle });
  expect((await payments.confirm({ actor: pending.creator.actor, paymentIntentId: payment.id, observedAmountVnd: payment.amountVnd,
    observedTransferReference: payment.reference, observedBankTransactionId: randomUUID(), attestedReceived: true, ...commandIds() })).state).toBe("confirmed");
});
test("listPublic marks packages not accepting while the fence is paused", async () => {
  const s = await f.setup("fixed_immediate", { intakeFence: pausedFence() }); const [pkg] = await s.catalog.listPublic(s.handle);
  expect(pkg).toMatchObject({ id: s.packageId, accepting: false }); expect(pkg).not.toHaveProperty("intakePause");
  expect((await s.catalog.getWorkspace(s.creator.actor)).intakePause).toEqual({ paused: true, overdue: [] });
});
