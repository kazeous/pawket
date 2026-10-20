import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as schema from "@pawket/database";
import { NOTIFICATION_SOURCE_EVENTS, createNotificationMaterializer } from "../src/materializer.js";
import { createNotificationFixture, createTestEmailPort, type CommittedRow, type FixtureOrder } from "./notification-fixture.js";

const f = createNotificationFixture("materializer");
beforeAll(f.initialize, 60_000); afterAll(f.dispose, 30_000);
const at = new Date("2026-10-02T03:00:00Z");
const event = (row: CommittedRow) => ({ outboxEventId: row.id, eventType: row.eventType, eventVersion: row.eventVersion, aggregateType: row.aggregateType, aggregateId: row.aggregateId });
function materializer(options: { mode?: "disabled" | "enabled"; fail?: boolean } = {}) {
  const email = createTestEmailPort({ fail: options.fail });
  return { email, service: createNotificationMaterializer({ db: f.db, mode: options.mode ?? "enabled", email: email.port, now: () => at }) };
}
const orderEvent = (o: FixtureOrder, type: string, state: string) =>
  f.outbox(type, "commission_order", o.orderId, { orderId: o.orderId, version: 2, state, reason: null, correlationId: randomUUID() });
const itemsFor = (sourceKey: string) => f.db.select().from(schema.notifications).where(eq(schema.notifications.sourceKey, sourceKey));
const setUser = (userId: string, values: Partial<typeof schema.identityUsers.$inferInsert>) => f.db.update(schema.identityUsers).set(values).where(eq(schema.identityUsers.id, userId));

describe("notification materializer", () => {
  test("the source set covers the Task 3, refund and thread message events", () => {
    expect(NOTIFICATION_SOURCE_EVENTS.has("refund.event_recorded.v1")).toBe(true);
    expect(NOTIFICATION_SOURCE_EVENTS.has("commission.requested.v1")).toBe(true);
    expect(NOTIFICATION_SOURCE_EVENTS.has("trust.case_opened.v1")).toBe(true);
    expect(NOTIFICATION_SOURCE_EVENTS.has("tip.notification_available.v1")).toBe(true);
    expect(NOTIFICATION_SOURCE_EVENTS.has("payments.verification_deposit_refund_sent.v1")).toBe(true);
    expect(NOTIFICATION_SOURCE_EVENTS.has("commission.message_sent.v1")).toBe(true);
    expect(NOTIFICATION_SOURCE_EVENTS.has("commission.confirmed.v1")).toBe(true);
    expect(NOTIFICATION_SOURCE_EVENTS.has("commission.in_progress.v1")).toBe(false);
    expect(NOTIFICATION_SOURCE_EVENTS.has("identity.user_registered.v1")).toBe(false);
  });

  test("a refund event creates its notices once, applies the email preference only to informational ones, and ignores a replay", async () => {
    const o = await f.paidOrder(); const obligationId = await f.refundObligation(o);
    const row = await f.outbox("refund.event_recorded.v1", "commission_refund_obligation", obligationId,
      { obligationId, refundEventId: await f.refundEvent(obligationId, "created"), action: "created" });
    await f.optOut(o.buyer.userId, "disputes_refunds"); await f.optOut(o.creator.userId, "disputes_refunds");
    const { email, service } = materializer();
    await expect(service.materialize(event(row))).resolves.toEqual({ created: 2, emailed: 1 });
    await expect(service.materialize(event(row))).resolves.toEqual({ created: 0, emailed: 0 });
    const items = await itemsFor(row.id);
    expect(items.map((item) => [item.kind, item.recipientUserId, item.actionRequired, item.emailState, item.linkPath]).sort()).toEqual([
      ["refund_account_needed", o.buyer.userId, true, "queued", `/commissions/${o.orderId}`],
      ["refund_owed", o.creator.userId, false, "suppressed", `/creator/commissions/${o.orderId}`],
    ].sort());
    expect(email.calls.map((call) => [call.kind, call.userId, call.variant])).toEqual([["refund_account_needed", o.buyer.userId, null]]);
  });

  test("disabled mode writes nothing", async () => {
    const o = await f.paidOrder(); const row = await orderEvent(o, "commission.completed.v1", "completed");
    const { email, service } = materializer({ mode: "disabled" });
    await expect(service.materialize(event(row))).resolves.toEqual({ created: 0, emailed: 0 });
    expect(await itemsFor(row.id)).toEqual([]); expect(email.calls).toEqual([]);
  });

  test("an event outside the source set writes nothing", async () => {
    const o = await f.paidOrder(); const row = await f.outbox("commission.catalog.publish.v1", "commission_catalog", o.packageId,
      { reference: o.packageId, actorUserId: o.creator.userId, correlationId: randomUUID() });
    const { email, service } = materializer();
    await expect(service.materialize(event(row))).resolves.toEqual({ created: 0, emailed: 0 });
    expect(await itemsFor(row.id)).toEqual([]); expect(email.calls).toEqual([]);
  });

  test("an informational order event creates one item per party and queues their emails", async () => {
    const o = await f.paidOrder(); const row = await orderEvent(o, "commission.completed.v1", "completed");
    const { email, service } = materializer();
    await expect(service.materialize(event(row))).resolves.toEqual({ created: 2, emailed: 2 });
    const items = await itemsFor(row.id);
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item).toMatchObject({ kind: "order_completed", category: "orders", actionRequired: false, subjectType: "commission_order", subjectId: o.orderId,
        emailState: "queued", emailDueAt: null, readAt: null, collapseKey: null });
      expect(item.emailHandoffId).not.toBeNull();
    }
    const handoffs = await f.db.select().from(schema.identityEmailHandoffs).where(inArray(schema.identityEmailHandoffs.id, items.map((item) => item.emailHandoffId!)));
    expect(handoffs.map((handoff) => handoff.templateData).sort((a, b) => a.linkPath!.localeCompare(b.linkPath!))).toEqual([
      { kind: "order_completed", variant: "", category: "orders", linkPath: `/commissions/${o.orderId}` },
      { kind: "order_completed", variant: "", category: "orders", linkPath: `/creator/commissions/${o.orderId}` }]);
    expect(email.calls.map((call) => call.notificationId).sort()).toEqual(items.map((item) => item.id).sort());
  });

  test("replaying a materialized event creates no second item or handoff", async () => {
    const o = await f.paidOrder(); const row = await orderEvent(o, "commission.delivered.v1", "delivered");
    const first = materializer(); const second = materializer();
    await expect(first.service.materialize(event(row))).resolves.toEqual({ created: 1, emailed: 1 });
    await expect(second.service.materialize(event(row))).resolves.toEqual({ created: 0, emailed: 0 });
    expect(await itemsFor(row.id)).toHaveLength(1); expect(second.email.calls).toEqual([]);
    const handoffs = await f.db.select().from(schema.identityEmailHandoffs).where(eq(schema.identityEmailHandoffs.userId, o.buyer.userId));
    expect(handoffs).toHaveLength(1);
  });

  test("action-required ignores an email opt-out", async () => {
    const o = await f.paidOrder(); await f.optOut(o.buyer.userId, "orders");
    const row = await orderEvent(o, "commission.delivered.v1", "delivered");
    const { service } = materializer();
    await expect(service.materialize(event(row))).resolves.toEqual({ created: 1, emailed: 1 });
    const [item] = await itemsFor(row.id);
    expect(item).toMatchObject({ recipientUserId: o.buyer.userId, actionRequired: true, emailState: "queued" });
  });

  test("informational respects an email opt-out and records suppressed", async () => {
    const o = await f.paidOrder(); await f.optOut(o.buyer.userId, "orders"); await f.optOut(o.buyer.userId, "messages");
    const row = await orderEvent(o, "commission.completed.v1", "completed");
    const { email, service } = materializer();
    await expect(service.materialize(event(row))).resolves.toEqual({ created: 2, emailed: 1 });
    const items = await itemsFor(row.id);
    expect(items.find((item) => item.recipientUserId === o.buyer.userId)).toMatchObject({ emailState: "suppressed", emailHandoffId: null, emailDueAt: null });
    expect(items.find((item) => item.recipientUserId === o.creator.userId)).toMatchObject({ emailState: "queued" });
    expect(email.calls.map((call) => call.userId)).toEqual([o.creator.userId]);
  });

  test("unverified address gives attention_required and the item still exists", async () => {
    const o = await f.paidOrder(); await setUser(o.buyer.userId, { emailVerified: false, emailVerifiedAt: null, emailVerificationProvenance: null });
    const row = await orderEvent(o, "commission.quoted.v1", "quoted");
    const { service } = materializer();
    await expect(service.materialize(event(row))).resolves.toEqual({ created: 1, emailed: 1 });
    const [item] = await itemsFor(row.id);
    expect(item).toMatchObject({ recipientUserId: o.buyer.userId, kind: "order_quoted", emailState: "attention_required" });
    const [handoff] = await f.db.select().from(schema.identityEmailHandoffs).where(eq(schema.identityEmailHandoffs.id, item!.emailHandoffId!));
    expect(handoff).toMatchObject({ status: "attention_required", failureCode: "no_verified_destination", purpose: "notification" });
  });

  test("closed account gets nothing", async () => {
    const o = await f.paidOrder(); await setUser(o.buyer.userId, { accessStatus: "closed" });
    const row = await orderEvent(o, "commission.completed.v1", "completed");
    const { email, service } = materializer();
    await expect(service.materialize(event(row))).resolves.toEqual({ created: 1, emailed: 1 });
    expect((await itemsFor(row.id)).map((item) => item.recipientUserId)).toEqual([o.creator.userId]);
    expect(email.calls.map((call) => call.userId)).toEqual([o.creator.userId]);
  });

  test("suspended account still gets order notices", async () => {
    const o = await f.paidOrder(); await setUser(o.creator.userId, { accessStatus: "access_suspended" });
    const row = await orderEvent(o, "commission.requested.v1", "requested");
    const { service } = materializer();
    await expect(service.materialize(event(row))).resolves.toEqual({ created: 1, emailed: 1 });
    expect(await itemsFor(row.id)).toMatchObject([{ recipientUserId: o.creator.userId, kind: "order_requested", emailState: "queued" }]);
  });

  test("account notices are never emailed", async () => {
    const applicant = await f.person(); const { applicationId } = await f.application(applicant);
    const row = await f.outbox("creator.application_outcome_email.v1", "creator_application", applicationId,
      { applicationId, applicantUserId: applicant, revisionId: randomUUID(), state: "approved", decisionAction: "approved", correlationId: randomUUID() });
    const { email, service } = materializer();
    await expect(service.materialize(event(row))).resolves.toEqual({ created: 1, emailed: 0 });
    expect(await itemsFor(row.id)).toMatchObject([{ recipientUserId: applicant, category: "account", emailState: "none", emailHandoffId: null }]);
    expect(email.calls).toEqual([]);
  });

  test("a job payload that differs from the committed row is refused", async () => {
    const o = await f.paidOrder(); const row = await orderEvent(o, "commission.completed.v1", "completed");
    const { email, service } = materializer();
    for (const forged of [{ eventType: "commission.closed.v1" }, { eventVersion: 2 }, { aggregateType: "payment_intent" }, { aggregateId: randomUUID() }]) {
      await expect(service.materialize({ ...event(row), ...forged })).rejects.toThrow();
    }
    await expect(service.materialize({ ...event(row), outboxEventId: randomUUID() })).rejects.toThrow();
    await expect(service.materialize({ ...event(row), outboxEventId: "not-a-uuid" })).rejects.toThrow();
    expect(await itemsFor(row.id)).toEqual([]); expect(email.calls).toEqual([]);
  });

  test("a materializer failure leaves the order, dispute and refund rows unchanged", async () => {
    const o = await f.paidOrder(); const disputeId = await f.dispute(o, "buyer");
    const snapshot = async () => ({
      orders: await f.db.select().from(schema.commissionOrders).where(eq(schema.commissionOrders.id, o.orderId)),
      disputes: await f.db.select().from(schema.commissionDisputes).where(eq(schema.commissionDisputes.id, disputeId)),
      refunds: await f.db.select().from(schema.commissionRefundObligations).where(eq(schema.commissionRefundObligations.orderId, o.orderId)),
      outbox: await f.db.select().from(schema.systemOutbox).where(eq(schema.systemOutbox.aggregateId, disputeId)),
    });
    const row = await f.outbox("resolution.dispute_opened.v1", "commission_dispute", disputeId, { disputeId, orderId: o.orderId });
    const before = await snapshot();
    const { email, service } = materializer({ fail: true });
    await expect(service.materialize(event(row))).rejects.toThrow();
    expect(email.calls).toHaveLength(1);
    expect(await snapshot()).toEqual(before);
    expect(await itemsFor(row.id)).toEqual([]);
    expect(await f.db.select().from(schema.identityEmailHandoffs).where(eq(schema.identityEmailHandoffs.userId, o.creator.userId))).toEqual([]);
  });
});
