import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import * as schema from "@pawket/database";
import { createDatabase } from "@pawket/database";
import { markNotificationsRead } from "../src/inbox-service.js";
import { createNotificationMaintenance, type NotificationMaintenanceFailure } from "../src/maintenance.js";
import { NOTIFICATION_SOURCE_EVENTS, createNotificationMaterializer } from "../src/materializer.js";
import { NOTIFICATION_POLICY } from "../src/policy.js";
import type { NotificationDeadlinePort, NotificationEmailPort } from "../src/ports.js";
import { createNotificationFixture, createTestEmailPort, type CommittedRow, type FixtureOrder } from "./notification-fixture.js";

const f = createNotificationFixture("digest");
beforeAll(f.initialize, 60_000); afterAll(f.dispose, 30_000);
// Each test owns its orders; earlier tests' pending items must not be picked up by a later digest run.
beforeEach(async () => {
  await f.db.update(schema.notifications).set({ emailState: "suppressed", emailDueAt: null }).where(eq(schema.notifications.emailState, "pending"));
});

const T = new Date("2026-10-02T03:00:00Z");
const minutes = (n: number) => new Date(T.getTime() + n * 60_000);
const deadlines: NotificationDeadlinePort = {
  resolution: async () => { throw new Error("unused"); }, completion: async () => { throw new Error("unused"); }, enforcement: async () => { throw new Error("unused"); },
};
const event = (row: CommittedRow) => ({ outboxEventId: row.id, eventType: row.eventType, eventVersion: row.eventVersion, aggregateType: row.aggregateType, aggregateId: row.aggregateId });

/** A committed thread message and its committed `commission.message_sent.v1` row, as thread-service writes them. */
async function sendMessage(order: FixtureOrder, author: "buyer" | "creator") {
  const messageId = await f.message(order.orderId, order[author].userId);
  const [entry] = await f.db.select({ sequence: schema.commissionThreadEntries.sequence }).from(schema.commissionThreadEntries)
    .where(and(eq(schema.commissionThreadEntries.entryId, messageId), eq(schema.commissionThreadEntries.kind, "message")));
  return f.outbox("commission.message_sent.v1", "commission_order", order.orderId, { orderId: order.orderId, messageId, sequence: entry!.sequence, correlationId: randomUUID() });
}
function materialize(row: CommittedRow, at: Date, mode: "disabled" | "enabled" = "enabled") {
  const email = createTestEmailPort();
  return createNotificationMaterializer({ db: f.db, mode, email: email.port, now: () => at }).materialize(event(row));
}
function maintenance(at: Date, options: { mode?: "disabled" | "enabled"; db?: typeof f.db; email?: NotificationEmailPort; batch?: number;
  failures?: NotificationMaintenanceFailure[] } = {}) {
  const email = createTestEmailPort();
  const service = createNotificationMaintenance({ db: options.db ?? f.db, mode: options.mode ?? "enabled", email: options.email ?? email.port, deadlines,
    now: () => at, batch: options.batch, onFailure: (failure) => options.failures?.push(failure) });
  return { service, calls: email.calls };
}
const messageItems = (userId: string, orderId: string) => f.db.select().from(schema.notifications)
  .where(and(eq(schema.notifications.recipientUserId, userId), eq(schema.notifications.collapseKey, `messages:${orderId}`)))
  .orderBy(schema.notifications.createdAt);

describe("thread message digest", () => {
  test("commission.message_sent.v1 is a notification source event", () => {
    expect(NOTIFICATION_SOURCE_EVENTS.has("commission.message_sent.v1")).toBe(true);
  });

  test("three messages make one item with count 3", async () => {
    const o = await f.paidOrder();
    const rows = [await sendMessage(o, "buyer"), await sendMessage(o, "buyer"), await sendMessage(o, "buyer")];
    await expect(materialize(rows[0]!, T)).resolves.toEqual({ created: 1, emailed: 0 });
    await expect(materialize(rows[1]!, minutes(1))).resolves.toEqual({ created: 0, emailed: 0 });
    await expect(materialize(rows[2]!, minutes(2))).resolves.toEqual({ created: 0, emailed: 0 });
    const items = await messageItems(o.creator.userId, o.orderId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "order_messages", variant: null, category: "messages", actionRequired: false, subjectType: "commission_order",
      subjectId: o.orderId, linkPath: `/creator/commissions/${o.orderId}`, collapseKey: `messages:${o.orderId}`, collapsedCount: 3,
      lastSequence: rows[2]!.payload.sequence, sourceKey: rows[0]!.id, emailState: "pending", emailDueAt: minutes(15), emailHandoffId: null,
      createdAt: T, updatedAt: minutes(2), readAt: null });
  });

  test("replaying a message event does not increase the count", async () => {
    const o = await f.paidOrder();
    const first = await sendMessage(o, "creator"); const second = await sendMessage(o, "creator");
    await materialize(first, T); await materialize(second, minutes(1));
    // Same event again, and an older event delivered after a newer one.
    await expect(materialize(second, minutes(2))).resolves.toEqual({ created: 0, emailed: 0 });
    await expect(materialize(first, minutes(3))).resolves.toEqual({ created: 0, emailed: 0 });
    expect(await messageItems(o.buyer.userId, o.orderId)).toMatchObject([{ collapsedCount: 2, lastSequence: second.payload.sequence, updatedAt: minutes(1) }]);
    // A replay after the item was read creates no new item either.
    await markNotificationsRead(f.db, { userId: o.buyer.userId, target: { orderId: o.orderId }, at: minutes(4) });
    await expect(materialize(second, minutes(5))).resolves.toEqual({ created: 0, emailed: 0 });
    expect(await messageItems(o.buyer.userId, o.orderId)).toHaveLength(1);
  });

  test("an unread item emails once after 15 minutes", async () => {
    const o = await f.paidOrder(); await materialize(await sendMessage(o, "buyer"), T);
    const early = maintenance(minutes(14));
    await expect(early.service.runOnce()).resolves.toEqual({ digestsQueued: 0, digestsDeferred: 0, digestsSuppressed: 0, digestsFailed: 0, remindersCreated: 0, remindersFailed: 0, deleted: 0 });
    expect(early.calls).toEqual([]);
    const due = maintenance(minutes(15));
    await expect(due.service.runOnce()).resolves.toEqual({ digestsQueued: 1, digestsDeferred: 0, digestsSuppressed: 0, digestsFailed: 0, remindersCreated: 0, remindersFailed: 0, deleted: 0 });
    const [item] = await messageItems(o.creator.userId, o.orderId);
    expect(due.calls).toEqual([{ notificationId: item!.id, userId: o.creator.userId, kind: "order_messages", variant: null, category: "messages",
      linkPath: `/creator/commissions/${o.orderId}`, at: minutes(15) }]);
    expect(item).toMatchObject({ emailState: "queued", emailDueAt: null, emailQueuedAt: minutes(15) });
    const [handoff] = await f.db.select().from(schema.identityEmailHandoffs).where(eq(schema.identityEmailHandoffs.id, item!.emailHandoffId!));
    expect(handoff).toMatchObject({ purpose: "notification", userId: o.creator.userId, sourceOutboxEventId: null,
      templateData: { kind: "order_messages", variant: "", category: "messages", linkPath: `/creator/commissions/${o.orderId}` } });
    // More messages collapse into the emailed item without a second email.
    await materialize(await sendMessage(o, "buyer"), minutes(20));
    const again = maintenance(minutes(90));
    await expect(again.service.runOnce()).resolves.toMatchObject({ digestsQueued: 0, digestsDeferred: 0 });
    expect(again.calls).toEqual([]);
    expect(await messageItems(o.creator.userId, o.orderId)).toMatchObject([{ collapsedCount: 2, emailState: "queued" }]);
  });

  test("reading before 15 minutes suppresses the email", async () => {
    const o = await f.paidOrder(); await materialize(await sendMessage(o, "buyer"), T);
    await expect(markNotificationsRead(f.db, { userId: o.creator.userId, target: { orderId: o.orderId }, at: minutes(5) })).resolves.toBe(1);
    expect(await messageItems(o.creator.userId, o.orderId)).toMatchObject([{ readAt: minutes(5), emailState: "suppressed", emailDueAt: null, emailHandoffId: null }]);
    const run = maintenance(minutes(15));
    await expect(run.service.runOnce()).resolves.toMatchObject({ digestsQueued: 0, digestsDeferred: 0 });
    expect(run.calls).toEqual([]);
    // The next message opens a new item with its own delay.
    await materialize(await sendMessage(o, "buyer"), minutes(16));
    const items = await messageItems(o.creator.userId, o.orderId);
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ collapsedCount: 1, readAt: null, emailState: "pending", emailDueAt: minutes(31) });
  });

  test("a second burst within the hour is deferred to one hour after the first email", async () => {
    const o = await f.paidOrder(); await materialize(await sendMessage(o, "buyer"), T);
    await expect(maintenance(minutes(15)).service.runOnce()).resolves.toMatchObject({ digestsQueued: 1 });
    await markNotificationsRead(f.db, { userId: o.creator.userId, target: { orderId: o.orderId }, at: minutes(20) });
    await materialize(await sendMessage(o, "buyer"), minutes(25));
    const deferred = maintenance(minutes(40));
    await expect(deferred.service.runOnce()).resolves.toEqual({ digestsQueued: 0, digestsDeferred: 1, digestsSuppressed: 0, digestsFailed: 0, remindersCreated: 0, remindersFailed: 0, deleted: 0 });
    expect(deferred.calls).toEqual([]);
    expect((await messageItems(o.creator.userId, o.orderId))[1]).toMatchObject({ emailState: "pending", emailDueAt: minutes(75), readAt: null });
    await expect(maintenance(minutes(74)).service.runOnce()).resolves.toMatchObject({ digestsQueued: 0, digestsDeferred: 0 });
    const sent = maintenance(minutes(75));
    await expect(sent.service.runOnce()).resolves.toMatchObject({ digestsQueued: 1, digestsDeferred: 0 });
    expect(sent.calls.map((call) => call.userId)).toEqual([o.creator.userId]);
    expect((await messageItems(o.creator.userId, o.orderId))[1]).toMatchObject({ emailState: "queued", emailQueuedAt: minutes(75) });
  });

  test("the author never gets an item", async () => {
    const o = await f.paidOrder();
    await materialize(await sendMessage(o, "buyer"), T); await materialize(await sendMessage(o, "creator"), minutes(1));
    expect(await messageItems(o.buyer.userId, o.orderId)).toMatchObject([{ linkPath: `/commissions/${o.orderId}`, collapsedCount: 1 }]);
    expect(await messageItems(o.creator.userId, o.orderId)).toMatchObject([{ linkPath: `/creator/commissions/${o.orderId}`, collapsedCount: 1 }]);
    const solo = await f.paidOrder(); await materialize(await sendMessage(solo, "buyer"), T);
    expect(await messageItems(solo.buyer.userId, solo.orderId)).toEqual([]);
  });

  test("messages opt-out records suppressed", async () => {
    const o = await f.paidOrder(); await f.optOut(o.creator.userId, "messages");
    await expect(materialize(await sendMessage(o, "buyer"), T)).resolves.toEqual({ created: 1, emailed: 0 });
    expect(await messageItems(o.creator.userId, o.orderId)).toMatchObject([{ emailState: "suppressed", emailDueAt: null, emailHandoffId: null, readAt: null }]);
    const run = maintenance(minutes(15));
    await expect(run.service.runOnce()).resolves.toMatchObject({ digestsQueued: 0 });
    expect(run.calls).toEqual([]);
  });

  test("an opt-out or a closed account after the item was created suppresses the pending digest", async () => {
    const o = await f.paidOrder(); const closed = await f.paidOrder();
    await materialize(await sendMessage(o, "buyer"), T); await materialize(await sendMessage(closed, "buyer"), T);
    await f.optOut(o.creator.userId, "messages");
    await f.db.update(schema.identityUsers).set({ accessStatus: "closed" }).where(eq(schema.identityUsers.id, closed.creator.userId));
    const run = maintenance(minutes(15));
    await expect(run.service.runOnce()).resolves.toMatchObject({ digestsQueued: 0, digestsDeferred: 0 });
    expect(run.calls).toEqual([]);
    expect(await messageItems(o.creator.userId, o.orderId)).toMatchObject([{ emailState: "suppressed", emailDueAt: null }]);
    expect(await messageItems(closed.creator.userId, closed.orderId)).toMatchObject([{ emailState: "suppressed", emailDueAt: null }]);
  });

  test("a closed account gets no message item", async () => {
    const o = await f.paidOrder();
    await f.db.update(schema.identityUsers).set({ accessStatus: "closed" }).where(eq(schema.identityUsers.id, o.creator.userId));
    await expect(materialize(await sendMessage(o, "buyer"), T)).resolves.toEqual({ created: 0, emailed: 0 });
    expect(await messageItems(o.creator.userId, o.orderId)).toEqual([]);
  });

  test("a payload that does not match the committed message is refused", async () => {
    const o = await f.paidOrder(); const real = await sendMessage(o, "buyer");
    const forged = [
      { ...real.payload, sequence: Number(real.payload.sequence) + 5 },
      { ...real.payload, messageId: randomUUID() },
    ];
    for (const payload of forged) {
      const row = await f.outbox("commission.message_sent.v1", "commission_order", o.orderId, payload);
      await expect(materialize(row, T)).rejects.toThrow();
    }
    const other = await f.paidOrder();
    const crossed = await f.outbox("commission.message_sent.v1", "commission_order", other.orderId, { ...real.payload, orderId: other.orderId });
    await expect(materialize(crossed, T)).rejects.toThrow();
    expect(await messageItems(o.creator.userId, o.orderId)).toEqual([]);
    expect(await messageItems(other.creator.userId, other.orderId)).toEqual([]);
  });

  test("two concurrent message jobs for one order make one item", async () => {
    const o = await f.paidOrder();
    const rows = [await sendMessage(o, "buyer"), await sendMessage(o, "buyer"), await sendMessage(o, "buyer"), await sendMessage(o, "buyer")];
    const second = createDatabase(f.scopedUrl);
    try {
      const email = createTestEmailPort();
      const on = (db: typeof f.db) => createNotificationMaterializer({ db, mode: "enabled", email: email.port, now: () => T });
      await Promise.all(rows.map((row, index) => on(index % 2 === 0 ? f.db : second.db).materialize(event(row))));
    } finally { await second.close(); }
    const items = await messageItems(o.creator.userId, o.orderId);
    expect(items).toHaveLength(1);
    expect(items[0]!.collapsedCount).toBeGreaterThanOrEqual(1);
    expect(items[0]!.collapsedCount).toBeLessThanOrEqual(4);
  });

  test("two concurrent digest runs queue one email", async () => {
    const o = await f.paidOrder(); await materialize(await sendMessage(o, "buyer"), T);
    const gate = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>();
    const inner = createTestEmailPort();
    const held: NotificationEmailPort = { async queue(tx, input) { entered.resolve(); await gate.promise; return inner.port.queue(tx, input); } };
    const second = createDatabase(f.scopedUrl);
    try {
      const first = maintenance(minutes(15), { email: held }).service.runOnce();
      await entered.promise;
      // The first run holds the row lock; the second run on its own connection skips it instead of waiting or sending again.
      const other = maintenance(minutes(15), { db: second.db });
      await expect(other.service.runOnce()).resolves.toMatchObject({ digestsQueued: 0, digestsDeferred: 0 });
      gate.resolve();
      await expect(first).resolves.toMatchObject({ digestsQueued: 1 });
      expect(other.calls).toEqual([]); expect(inner.calls).toHaveLength(1);
    } finally { gate.resolve(); await second.close(); }
    const handoffs = await f.db.select().from(schema.identityEmailHandoffs).where(eq(schema.identityEmailHandoffs.userId, o.creator.userId));
    expect(handoffs).toHaveLength(1);
  });

  test("disabled maintenance queues nothing", async () => {
    const o = await f.paidOrder(); await materialize(await sendMessage(o, "buyer"), T);
    const old = await f.db.execute(sql`select count(*)::int as count from notifications`);
    const run = maintenance(minutes(15_000_000), { mode: "disabled" });
    await expect(run.service.runOnce()).resolves.toEqual({ digestsQueued: 0, digestsDeferred: 0, digestsSuppressed: 0, digestsFailed: 0, remindersCreated: 0, remindersFailed: 0, deleted: 0 });
    expect(run.calls).toEqual([]);
    expect(await messageItems(o.creator.userId, o.orderId)).toMatchObject([{ emailState: "pending", emailDueAt: minutes(15) }]);
    expect(await f.db.execute(sql`select count(*)::int as count from notifications`)).toEqual(old);
  });

  test("disabled materializer writes no message item", async () => {
    const o = await f.paidOrder();
    await expect(materialize(await sendMessage(o, "buyer"), T, "disabled")).resolves.toEqual({ created: 0, emailed: 0 });
    expect(await messageItems(o.creator.userId, o.orderId)).toEqual([]);
  });

  test("the digest scan only reads thread-message items", async () => {
    const o = await f.paidOrder(); await materialize(await sendMessage(o, "buyer"), T);
    // A pending item that is not a collapsed thread message is not the digest's business, and no longer fails its batch.
    const [stray] = await f.db.insert(schema.notifications).values({ recipientUserId: o.creator.userId, kind: "order_completed", category: "orders", actionRequired: false,
      subjectType: "commission_order", subjectId: o.orderId, linkPath: `/creator/commissions/${o.orderId}`, sourceKey: randomUUID(), emailState: "pending",
      emailDueAt: minutes(1), createdAt: T, updatedAt: T }).returning();
    const failures: NotificationMaintenanceFailure[] = [];
    const run = maintenance(minutes(15), { failures });
    await expect(run.service.runOnce()).resolves.toMatchObject({ digestsQueued: 1, digestsFailed: 0 });
    expect(failures).toEqual([]);
    expect(run.calls.map((call) => call.kind)).toEqual(["order_messages"]);
    const [after] = await f.db.select().from(schema.notifications).where(eq(schema.notifications.id, stray!.id));
    expect(after).toMatchObject({ emailState: "pending", emailDueAt: minutes(1), emailHandoffId: null });
    await f.db.update(schema.notifications).set({ emailState: "suppressed", emailDueAt: null }).where(eq(schema.notifications.id, stray!.id));
  });

  test("one failing digest item is counted and logged by id while the rest are sent", async () => {
    const broken = await f.paidOrder(); const healthy = await f.paidOrder();
    await materialize(await sendMessage(broken, "buyer"), T); await materialize(await sendMessage(healthy, "buyer"), minutes(1));
    const inner = createTestEmailPort();
    const email: NotificationEmailPort = { async queue(tx, notice) {
      if (notice.userId === broken.creator.userId) throw new Error("synthetic email failure");
      return inner.port.queue(tx, notice);
    } };
    const failures: NotificationMaintenanceFailure[] = [];
    await expect(maintenance(minutes(16), { email, failures }).service.runOnce()).resolves.toMatchObject({ digestsQueued: 1, digestsFailed: 1 });
    const [brokenItem] = await messageItems(broken.creator.userId, broken.orderId);
    expect(failures).toEqual([{ step: "digest", notificationId: brokenItem!.id }]);
    expect(brokenItem).toMatchObject({ emailState: "pending", emailDueAt: minutes(15), emailHandoffId: null });
    expect(await messageItems(healthy.creator.userId, healthy.orderId)).toMatchObject([{ emailState: "queued", emailQueuedAt: minutes(16) }]);
    // The failed item is retried on the next run.
    await expect(maintenance(minutes(17)).service.runOnce()).resolves.toMatchObject({ digestsQueued: 1, digestsFailed: 0 });
    expect(await messageItems(broken.creator.userId, broken.orderId)).toMatchObject([{ emailState: "queued", emailQueuedAt: minutes(17) }]);
  });

  test("a digest overdue by more than the spacing window is suppressed instead of sent", async () => {
    const stale = await f.paidOrder(); const fresh = await f.paidOrder();
    await materialize(await sendMessage(stale, "buyer"), T); await materialize(await sendMessage(fresh, "buyer"), minutes(46));
    // Stale is due at 15 and fresh at 61; at 76 the stale one is more than an hour late (a long outage or re-enabling).
    const run = maintenance(minutes(76));
    await expect(run.service.runOnce()).resolves.toMatchObject({ digestsQueued: 1, digestsSuppressed: 1, digestsFailed: 0 });
    expect(run.calls.map((call) => call.userId)).toEqual([fresh.creator.userId]);
    expect(await messageItems(stale.creator.userId, stale.orderId)).toMatchObject([{ emailState: "suppressed", emailDueAt: null, emailHandoffId: null, readAt: null }]);
    expect(await messageItems(fresh.creator.userId, fresh.orderId)).toMatchObject([{ emailState: "queued", emailQueuedAt: minutes(76) }]);
    // Exactly at the spacing boundary the email still goes.
    const edge = await f.paidOrder(); await materialize(await sendMessage(edge, "buyer"), minutes(100));
    await expect(maintenance(minutes(175)).service.runOnce()).resolves.toMatchObject({ digestsQueued: 1, digestsSuppressed: 0 });
  });

  test("the digest delay and spacing come from the policy", () => {
    expect(NOTIFICATION_POLICY.digestDelayMs).toBe(15 * 60_000); expect(NOTIFICATION_POLICY.digestSpacingMs).toBe(60 * 60_000);
  });
});
