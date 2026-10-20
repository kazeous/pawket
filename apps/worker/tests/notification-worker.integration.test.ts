import { and, eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { OUTBOX_JOB, type SystemOutboxJob } from "@pawket/queue";
import { createCommissionResolutionTestFixture } from "../../web/tests/commission-resolution-test-support.js";
import { fixtureKeyring, schema } from "../../../packages/payments/tests/sepay-integration-fixture.js";
import { createWorkerNotificationConfiguration } from "../src/notification-wiring.js";
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
  expect(creatorItem).toMatchObject({ recipientUserId: p.creator.userId, kind: "draft_responded", variant: "changes_requested", emailState: "queued" });
  const [queued] = await f.db.select().from(schema.identityEmailHandoffs).where(eq(schema.identityEmailHandoffs.id, creatorItem!.emailHandoffId!));
  expect(queued).toMatchObject({ status: "pending", purpose: "notification", sourceOutboxEventId: null,
    templateData: { kind: "draft_responded", variant: "changes_requested", category: "deliveries", linkPath: `/creator/commissions/${p.orderId}` } });
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
