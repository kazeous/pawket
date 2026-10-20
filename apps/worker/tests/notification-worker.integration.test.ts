import { randomUUID } from "node:crypto";
import { and, eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { OUTBOX_JOB, type SystemOutboxJob } from "@pawket/queue";
import { createCommissionResolutionTestFixture } from "../../web/tests/commission-resolution-test-support.js";
import { fixtureKeyring, schema } from "../../../packages/payments/tests/sepay-integration-fixture.js";
import { metricsRegistry } from "@pawket/observability";
import { readCommissionCompletionDueAt } from "@pawket/orders";
import { effectiveResolutionDeadline } from "@pawket/resolutions";
import { effectiveEnforcementDeadline } from "@pawket/trust";
import { createWorkerNotificationConfiguration, createWorkerNotificationMaintenance, workerNotificationDeadlines } from "../src/notification-wiring.js";
import { createWorkerJobProcessor } from "../src/worker-runtime.js";

const f = createCommissionResolutionTestFixture("i9notify");
beforeAll(f.initialize, 60_000); afterAll(f.dispose, 30_000);
const job = (row: typeof schema.systemOutbox.$inferSelect): SystemOutboxJob => ({ outboxEventId: row.id, eventType: row.eventType,
  eventVersion: row.eventVersion, aggregateType: row.aggregateType, aggregateId: row.aggregateId, payload: row.payload, occurredAt: row.occurredAt.toISOString() });
async function paidOrderEvents() {
  const p = await f.paidOrder();
  await f.db.update(schema.identityUsers).set({ emailVerified: true, emailVerifiedAt: new Date("2026-10-01T00:00:00Z"), emailVerificationProvenance: "password_email_challenge" })
    .where(eq(schema.identityUsers.id, p.creator.userId));
  const rows = (await f.db.select().from(schema.systemOutbox).where(like(schema.systemOutbox.eventType, "commission.%"))).filter((row) => row.payload.orderId === p.orderId);
  return { p, rows: rows.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()) };
}

test("enabled notifications materialize committed order events through the real email handoff", async () => {
  const { p, rows: paid } = await paidOrderEvents();
  const draft = await f.submit(p, "draft");
  const rows = [...paid, ...(await f.db.select().from(schema.systemOutbox).where(eq(schema.systemOutbox.eventType, "commission.submission_sent.v1")))
    .filter((row) => row.payload.submissionId === draft.id)];
  // Payment confirmation commits commission.confirmed.v1 (payment_intent aggregate); Ruling R7 announces it to both parties.
  expect(paid.map((row) => row.eventType)).toEqual(["commission.awaiting_payment.v1", "commission.confirmed.v1"]);
  const configuration = createWorkerNotificationConfiguration({ NOTIFICATIONS_MODE: "enabled" }, fixtureKeyring);
  const acknowledge = vi.fn(async () => true); const logger = { info: vi.fn(), error: vi.fn() };
  const processor = createWorkerJobProcessor({ database: f.db, acknowledge, logger, notifications: configuration.createMaterializer(f.db) });
  for (const row of rows) for (let attempt = 0; attempt < 2; attempt += 1) await processor({ id: row.id, name: OUTBOX_JOB, data: job(row) } as never);
  expect(acknowledge).toHaveBeenCalledTimes(6); expect(logger.error).not.toHaveBeenCalled();

  const items = await f.db.select().from(schema.notifications).where(inArray(schema.notifications.sourceKey, rows.map((row) => row.id)));
  expect(items.map((item) => [item.kind, item.recipientUserId, item.linkPath, item.emailState]).sort()).toEqual([
    ["draft_sent", p.buyer.userId, `/commissions/${p.orderId}`, "attention_required"],
    ["order_in_progress", p.buyer.userId, `/commissions/${p.orderId}`, "attention_required"],
    ["order_in_progress", p.creator.userId, `/creator/commissions/${p.orderId}`, "queued"],
    ["order_payment_due", p.buyer.userId, `/commissions/${p.orderId}`, "attention_required"],
  ].sort());
  const handoffs = await f.db.select().from(schema.identityEmailHandoffs).where(inArray(schema.identityEmailHandoffs.id, items.map((item) => item.emailHandoffId!)));
  expect(handoffs).toHaveLength(4);
  for (const handoff of handoffs) {
    expect(handoff.purpose).toBe("notification"); expect(handoff.sourceOutboxEventId).toBeNull();
    expect(Object.keys(handoff.templateData).sort()).toEqual(["category", "kind", "linkPath", "variant"]);
  }
  expect(handoffs.filter((handoff) => handoff.userId === p.buyer.userId).every((handoff) => handoff.status === "attention_required" && handoff.failureCode === "no_verified_destination")).toBe(true);
  expect(handoffs.find((handoff) => handoff.userId === p.creator.userId)).toMatchObject({ status: "pending",
    templateData: { kind: "order_in_progress", variant: "", category: "orders", linkPath: `/creator/commissions/${p.orderId}` } });

  // A verified creator gets a pending handoff and its delivery request.
  await f.respond(p, draft.id, "request_changes");
  const responded = (await f.db.select().from(schema.systemOutbox).where(eq(schema.systemOutbox.eventType, "commission.submission_responded.v1")))
    .filter((row) => row.payload.submissionId === draft.id);
  expect(responded).toHaveLength(1);
  await processor({ id: responded[0]!.id, name: OUTBOX_JOB, data: job(responded[0]!) } as never);
  const [creatorItem] = await f.db.select().from(schema.notifications).where(eq(schema.notifications.sourceKey, responded[0]!.id));
  expect(creatorItem).toMatchObject({ recipientUserId: p.creator.userId, kind: "draft_responded", variant: "draft", emailState: "queued" });
  const [queued] = await f.db.select().from(schema.identityEmailHandoffs).where(eq(schema.identityEmailHandoffs.id, creatorItem!.emailHandoffId!));
  expect(queued).toMatchObject({ status: "pending", purpose: "notification", sourceOutboxEventId: null,
    templateData: { kind: "draft_responded", variant: "draft", category: "deliveries", linkPath: `/creator/commissions/${p.orderId}` } });
  const requests = await f.db.select().from(schema.systemOutbox).where(and(eq(schema.systemOutbox.eventType, "identity.security_email.requested.v1"), eq(schema.systemOutbox.aggregateId, queued!.id)));
  expect(requests).toHaveLength(1);

  // The change request also reopens the order with commission.in_progress.v1, which produces no item (Ruling R7).
  const reopened = (await f.db.select().from(schema.systemOutbox).where(eq(schema.systemOutbox.eventType, "commission.in_progress.v1")))
    .filter((row) => row.payload.orderId === p.orderId);
  expect(reopened.map((row) => row.payload.reason)).toEqual(["draft_changes_requested"]);
  await processor({ id: reopened[0]!.id, name: OUTBOX_JOB, data: job(reopened[0]!) } as never);
  expect(await f.db.select().from(schema.notifications).where(eq(schema.notifications.sourceKey, reopened[0]!.id))).toEqual([]);
  expect((await f.db.select().from(schema.notifications).where(eq(schema.notifications.recipientUserId, p.buyer.userId)))
    .filter((item) => item.kind === "order_in_progress")).toHaveLength(1);
  expect(logger.error).not.toHaveBeenCalled();
});

test("disabled or unwired notifications acknowledge exactly as before", async () => {
  const { rows } = await paidOrderEvents();
  const disabled = createWorkerNotificationConfiguration({ NOTIFICATIONS_MODE: "disabled" }, fixtureKeyring);
  expect(disabled.mode).toBe("disabled");
  const acknowledge = vi.fn(async () => true);
  const unwired = createWorkerJobProcessor({ database: f.db, acknowledge, logger: { info: vi.fn(), error: vi.fn() } });
  for (const row of rows) await unwired({ id: row.id, name: OUTBOX_JOB, data: job(row) } as never);
  expect(acknowledge).toHaveBeenCalledTimes(rows.length);
  expect(await f.db.select().from(schema.notifications).where(inArray(schema.notifications.sourceKey, rows.map((row) => row.id)))).toEqual([]);
});

test("enabled maintenance queues a due message digest through the real email handoff", async () => {
  const { p } = await paidOrderEvents();
  const configuration = createWorkerNotificationConfiguration({ NOTIFICATIONS_MODE: "enabled" }, fixtureKeyring);
  expect(typeof configuration.createMaintenance).toBe("function");
  const createdAt = new Date("2026-10-01T05:00:00Z"); const at = new Date(createdAt.getTime() + 15 * 60_000);
  const [item] = await f.db.insert(schema.notifications).values({ recipientUserId: p.creator.userId, kind: "order_messages", category: "messages", actionRequired: false,
    subjectType: "commission_order", subjectId: p.orderId, linkPath: `/creator/commissions/${p.orderId}`, collapseKey: `messages:${p.orderId}`, lastSequence: 1,
    sourceKey: randomUUID(), emailState: "pending", emailDueAt: at, createdAt, updatedAt: createdAt }).returning();
  const digestLine = async () => Number((await metricsRegistry.metrics()).split("\n")
    .find((line) => line.startsWith('pawket_notification_operations_total{operation="digest",outcome="queued"}'))?.split(" ").at(-1) ?? 0);
  const before = await digestLine();
  const result = await createWorkerNotificationMaintenance({ db: f.db, keyring: fixtureKeyring, now: () => at }).runOnce();
  expect(result.digestsQueued).toBeGreaterThanOrEqual(1);
  expect(await digestLine()).toBe(before + result.digestsQueued);
  const [after] = await f.db.select().from(schema.notifications).where(eq(schema.notifications.id, item!.id));
  expect(after).toMatchObject({ emailState: "queued", emailQueuedAt: at, emailDueAt: null });
  const [handoff] = await f.db.select().from(schema.identityEmailHandoffs).where(eq(schema.identityEmailHandoffs.id, after!.emailHandoffId!));
  expect(handoff).toMatchObject({ status: "pending", purpose: "notification", sourceOutboxEventId: null,
    templateData: { kind: "order_messages", variant: "", category: "messages", linkPath: `/creator/commissions/${p.orderId}` } });
});

test("the worker deadline port reads each module's effective deadline", async () => {
  const deadline = new Date("2026-11-03T04:00:00Z"); const review = { reviewEndsAt: new Date("2026-11-04T04:00:00Z"), completionFloorAt: new Date("2026-11-05T04:00:00Z") };
  await f.db.transaction(async (tx) => {
    expect(await workerNotificationDeadlines.resolution(tx, deadline)).toEqual(await effectiveResolutionDeadline(tx, deadline));
    expect(await workerNotificationDeadlines.enforcement(tx, deadline)).toEqual(await effectiveEnforcementDeadline(tx, deadline));
    expect(await workerNotificationDeadlines.completion(tx, review)).toEqual(await readCommissionCompletionDueAt(tx, review));
    expect(await workerNotificationDeadlines.completion(tx, review)).toEqual(review.completionFloorAt);
  });
});

test("enabled maintenance sends a review-window reminder at the real completion deadline", async () => {
  const p = await f.deliveredOrder();
  const [order] = await f.db.select().from(schema.commissionOrders).where(eq(schema.commissionOrders.id, p.orderId));
  const due = await f.db.transaction((tx) => readCommissionCompletionDueAt(tx, { reviewEndsAt: order!.reviewEndsAt!, completionFloorAt: order!.completionFloorAt }));
  const reminderLine = async () => Number((await metricsRegistry.metrics()).split("\n")
    .find((line) => line.startsWith('pawket_notification_operations_total{operation="reminder",outcome="created"}'))?.split(" ").at(-1) ?? 0);
  const before = await reminderLine();
  const result = await createWorkerNotificationMaintenance({ db: f.db, keyring: fixtureKeyring, now: () => new Date(due!.getTime() - 12 * 3_600_000) }).runOnce();
  expect(result.remindersCreated).toBeGreaterThanOrEqual(1); expect(result.remindersFailed).toBe(0);
  expect(await reminderLine()).toBe(before + result.remindersCreated);
  const items = await f.db.select().from(schema.notifications).where(and(eq(schema.notifications.subjectId, p.orderId), eq(schema.notifications.kind, "reminder_due")));
  expect(items).toMatchObject([{ recipientUserId: p.buyer.userId, variant: "review_window", category: "orders", actionRequired: true, linkPath: `/commissions/${p.orderId}` }]);
  expect(["queued", "attention_required"]).toContain(items[0]!.emailState);
  const [ledger] = await f.db.select().from(schema.notificationReminders).where(eq(schema.notificationReminders.subjectId, p.orderId));
  expect(ledger).toMatchObject({ clock: "review_window", stage: "due_24h", effectiveDeadline: due });
});

test("a digest overdue by more than an hour is suppressed and counted", async () => {
  const { p } = await paidOrderEvents();
  const createdAt = new Date("2026-10-01T06:00:00Z"); const at = new Date(createdAt.getTime() + 3 * 3_600_000);
  const [item] = await f.db.insert(schema.notifications).values({ recipientUserId: p.creator.userId, kind: "order_messages", category: "messages", actionRequired: false,
    subjectType: "commission_order", subjectId: p.orderId, linkPath: `/creator/commissions/${p.orderId}`, collapseKey: `messages:${p.orderId}`, lastSequence: 1,
    sourceKey: randomUUID(), emailState: "pending", emailDueAt: new Date(createdAt.getTime() + 15 * 60_000), createdAt, updatedAt: createdAt }).returning();
  const suppressedLine = async () => Number((await metricsRegistry.metrics()).split("\n")
    .find((line) => line.startsWith('pawket_notification_operations_total{operation="digest",outcome="suppressed"}'))?.split(" ").at(-1) ?? 0);
  const before = await suppressedLine();
  const result = await createWorkerNotificationMaintenance({ db: f.db, keyring: fixtureKeyring, now: () => at }).runOnce();
  expect(result.digestsSuppressed).toBeGreaterThanOrEqual(1);
  expect(await suppressedLine()).toBe(before + result.digestsSuppressed);
  const [after] = await f.db.select().from(schema.notifications).where(eq(schema.notifications.id, item!.id));
  expect(after).toMatchObject({ emailState: "suppressed", emailDueAt: null, emailHandoffId: null });
});
