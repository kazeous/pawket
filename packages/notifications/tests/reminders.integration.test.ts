import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as schema from "@pawket/database";
import { createDatabase } from "@pawket/database";
import { readOpenClocks } from "../src/clocks.js";
import { createNotificationMaintenance, type NotificationMaintenanceFailure } from "../src/maintenance.js";
import type { NotificationDeadlinePort, NotificationEmailPort } from "../src/ports.js";
import { createNotificationFixture, createTestEmailPort, fixtureAt } from "./notification-fixture.js";

const f = createNotificationFixture("reminders");
beforeAll(f.initialize, 60_000); afterAll(f.dispose, 30_000);

const HOUR = 3_600_000; const DAY = 24 * HOUR;
const later = (ms: number) => new Date(fixtureAt.getTime() + ms);
const shift = (date: Date, ms: number) => new Date(date.getTime() + ms);

/** Pass-through deadlines, as the owning modules return them with no pause in force. */
const passThrough: NotificationDeadlinePort = {
  resolution: async (_tx, deadline) => new Date(deadline),
  completion: async (_tx, order) => new Date(Math.max(order.reviewEndsAt.getTime(), order.completionFloorAt?.getTime() ?? 0)),
  enforcement: async (_tx, deadline) => new Date(deadline),
};

async function run(at: Date, options: { mode?: "disabled" | "enabled"; deadlines?: NotificationDeadlinePort; email?: NotificationEmailPort; db?: typeof f.db;
  failures?: NotificationMaintenanceFailure[] } = {}) {
  const email = createTestEmailPort();
  const service = createNotificationMaintenance({ db: options.db ?? f.db, mode: options.mode ?? "enabled", email: options.email ?? email.port,
    deadlines: options.deadlines ?? passThrough, now: () => at, onFailure: (failure) => options.failures?.push(failure) });
  return { result: await service.runOnce(), calls: email.calls };
}
const items = (subjectId: string) => f.db.select().from(schema.notifications).where(eq(schema.notifications.subjectId, subjectId))
  .orderBy(asc(schema.notifications.createdAt), asc(schema.notifications.recipientUserId));
const ledger = (subjectId: string) => f.db.select().from(schema.notificationReminders).where(eq(schema.notificationReminders.subjectId, subjectId))
  .orderBy(asc(schema.notificationReminders.effectiveDeadline));
const reminders = async (subjectId: string) => (await items(subjectId)).filter((item) => item.kind === "reminder_due" || item.kind === "deadline_missed");

/** Exactly one action-required 24-hour reminder for the acting party, emailed now, sourced from the ledger row. */
async function expectOneReminder(subjectId: string, expected: { recipient: string; clock: string; category: string; subjectType: string; linkPath: string; actionRequired?: boolean }) {
  const found = await reminders(subjectId);
  expect(found).toHaveLength(1);
  const [row] = await ledger(subjectId);
  expect(row).toMatchObject({ subjectType: expected.subjectType, subjectId, clock: expected.clock, stage: "due_24h" });
  expect(found[0]).toMatchObject({ recipientUserId: expected.recipient, kind: "reminder_due", variant: expected.clock, category: expected.category,
    actionRequired: expected.actionRequired ?? true, subjectType: expected.subjectType, subjectId, linkPath: expected.linkPath, collapseKey: null,
    sourceKey: row!.id, emailState: "queued" });
  expect(found[0]!.emailHandoffId).not.toBeNull();
}

describe("24-hour reminders, one per clock", () => {
  test("request_response reminds the creator", async () => {
    const o = await f.requestedOrder({ expiresAt: later(3 * DAY) });
    await run(later(3 * DAY - 12 * HOUR));
    await expectOneReminder(o.orderId, { recipient: o.creator.userId, clock: "request_response", category: "orders", subjectType: "commission_order",
      linkPath: `/creator/commissions/${o.orderId}` });
  });

  test("quote_acceptance reminds the buyer", async () => {
    const o = await f.quotedOrder({ issuedAt: later(HOUR), expiresAt: later(HOUR + 3 * DAY) });
    await run(later(HOUR + 3 * DAY - 12 * HOUR));
    await expectOneReminder(o.orderId, { recipient: o.buyer.userId, clock: "quote_acceptance", category: "orders", subjectType: "commission_order",
      linkPath: `/commissions/${o.orderId}` });
  });

  test("payment reads the buyer's clock, but its 24-hour window is always under the 36-hour minimum notice", async () => {
    const o = await f.awaitingOrder();
    const open = await f.db.transaction((tx) => readOpenClocks(tx, { clock: "payment", now: later(12 * HOUR), limit: 200, deadlines: passThrough }));
    expect(open.find((clock) => clock.subjectId === o.orderId)).toEqual({ clock: "payment", subjectType: "commission_order", subjectId: o.orderId, orderId: o.orderId,
      recipients: [{ userId: o.buyer.userId, role: "buyer" }], startedAt: fixtureAt, effectiveDeadline: later(DAY), missedBy: "domain" });
    await run(later(12 * HOUR));
    expect(await reminders(o.orderId)).toEqual([]);
    expect(await ledger(o.orderId)).toEqual([]);
  });

  test("delivery_due reminds the creator", async () => {
    const o = await f.paidOrder(); const due = later(1_000 + 7 * DAY);
    await run(shift(due, -12 * HOUR));
    await expectOneReminder(o.orderId, { recipient: o.creator.userId, clock: "delivery_due", category: "orders", subjectType: "commission_order",
      linkPath: `/creator/commissions/${o.orderId}` });
  });

  test("review_window reminds the buyer at the completion deadline", async () => {
    const o = await f.paidOrder(); await f.submission(o, "final");
    const deadlines: NotificationDeadlinePort = { ...passThrough, completion: async (_tx, order) => shift(order.reviewEndsAt, 6 * HOUR) };
    const reviewEndsAt = later(30_000 + 7 * DAY);
    // Still more than 24 hours before the completion deadline the module reports.
    await run(shift(reviewEndsAt, -19 * HOUR), { deadlines });
    expect(await reminders(o.orderId)).toEqual([]);
    await run(shift(reviewEndsAt, -12 * HOUR), { deadlines });
    await expectOneReminder(o.orderId, { recipient: o.buyer.userId, clock: "review_window", category: "orders", subjectType: "commission_order",
      linkPath: `/commissions/${o.orderId}` });
    expect((await ledger(o.orderId))[0]!.effectiveDeadline).toEqual(shift(reviewEndsAt, 6 * HOUR));
  });

  test("proposal_response reminds the other party", async () => {
    const o = await f.paidOrder(); const id = await f.proposal(o, "buyer");
    await run(later(2_000 + 60 * HOUR));
    await expectOneReminder(id, { recipient: o.creator.userId, clock: "proposal_response", category: "disputes_refunds", subjectType: "commission_proposal",
      linkPath: `/creator/commissions/${o.orderId}` });
  });

  test("dispute_response reminds the respondent", async () => {
    const o = await f.paidOrder(); const id = await f.dispute(o, "creator");
    await run(later(4_000 + 5 * DAY - 12 * HOUR));
    await expectOneReminder(id, { recipient: o.buyer.userId, clock: "dispute_response", category: "disputes_refunds", subjectType: "commission_dispute",
      linkPath: `/commissions/${o.orderId}` });
  });

  test("late_claim_response reminds the creator", async () => {
    const o = await f.expiredOrder(); const id = await f.lateClaim(o);
    await run(shift(o.closedAt, 1_000 + 5 * DAY - 12 * HOUR));
    await expectOneReminder(id, { recipient: o.creator.userId, clock: "late_claim_response", category: "disputes_refunds", subjectType: "commission_late_payment_claim",
      linkPath: `/creator/commissions/${o.orderId}` });
  });

  test("refund_send reminds the creator", async () => {
    const o = await f.paidOrder(); const id = await f.refundObligation(o);
    await f.refundAwaitingSend(id, { enteredAt: later(60_000), dueAt: later(60_000 + 5 * DAY) });
    await run(later(60_000 + 5 * DAY - 12 * HOUR));
    await expectOneReminder(id, { recipient: o.creator.userId, clock: "refund_send", category: "disputes_refunds", subjectType: "commission_refund_obligation",
      linkPath: `/creator/commissions/${o.orderId}` });
  });

  test("refund_confirm reminds the buyer", async () => {
    const o = await f.paidOrder(); const id = await f.refundObligation(o);
    await f.refundAwaitingSend(id, { enteredAt: later(60_000), dueAt: later(60_000 + 5 * DAY) });
    await f.refundSent(id, later(DAY));
    await run(later(DAY + 7 * DAY - 12 * HOUR));
    await expectOneReminder(id, { recipient: o.buyer.userId, clock: "refund_confirm", category: "disputes_refunds", subjectType: "commission_refund_obligation",
      linkPath: `/commissions/${o.orderId}` });
  });

  test("appeal_window reminds the content owner", async () => {
    const owner = await f.owner(); const o = await f.paidOrder(); const report = await f.reportCase(o, [o.buyer.userId]);
    const hideId = await f.hide(o, report, owner);
    await run(later(11_000 + 14 * DAY - 12 * HOUR));
    await expectOneReminder(hideId, { recipient: o.creator.userId, clock: "appeal_window", category: "moderation", subjectType: "trust_content_hide",
      linkPath: "/help/cases", actionRequired: false });
  });
});

describe("reminder rules", () => {
  test("delivery_due and dispute_response produce one deadline_missed to both parties", async () => {
    const late = await f.paidOrder(); const due = later(1_000 + 7 * DAY);
    await run(shift(due, HOUR)); await run(shift(due, 2 * HOUR));
    const missed = await reminders(late.orderId);
    expect(missed.map((item) => [item.recipientUserId, item.kind, item.variant, item.category, item.actionRequired, item.linkPath, item.emailState]).sort()).toEqual([
      [late.buyer.userId, "deadline_missed", "delivery_due", "orders", true, `/commissions/${late.orderId}`, "queued"],
      [late.creator.userId, "deadline_missed", "delivery_due", "orders", true, `/creator/commissions/${late.orderId}`, "queued"],
    ].sort());
    expect(await ledger(late.orderId)).toMatchObject([{ clock: "delivery_due", stage: "missed", effectiveDeadline: due }]);
    expect(new Set(missed.map((item) => item.sourceKey))).toEqual(new Set([(await ledger(late.orderId))[0]!.id]));

    const o = await f.paidOrder(); const disputeId = await f.dispute(o, "buyer"); const respondBy = later(4_000 + 5 * DAY);
    const answered = await f.paidOrder(); const answeredId = await f.dispute(answered, "buyer");
    await f.statement(answeredId, answered.creator.userId, "creator", "response");
    // A statement that is not a response, or the opener's own response, does not stop the clock.
    await f.statement(disputeId, o.creator.userId, "creator", "statement"); await f.statement(disputeId, o.buyer.userId, "buyer", "response");
    await run(shift(respondBy, HOUR)); await run(shift(respondBy, 3 * HOUR));
    expect((await reminders(disputeId)).map((item) => [item.recipientUserId, item.kind, item.variant, item.category, item.linkPath]).sort()).toEqual([
      [o.buyer.userId, "deadline_missed", "dispute_response", "disputes_refunds", `/commissions/${o.orderId}`],
      [o.creator.userId, "deadline_missed", "dispute_response", "disputes_refunds", `/creator/commissions/${o.orderId}`],
    ].sort());
    expect(await reminders(answeredId)).toEqual([]);
    // Domain clocks never get a scan-made missed notice.
    const proposalOrder = await f.paidOrder(); const proposalId = await f.proposal(proposalOrder, "creator");
    await run(later(2_000 + 80 * HOUR));
    expect(await reminders(proposalId)).toEqual([]);
  });

  test("no reminder when the action commits after discovery", async () => {
    const o = await f.quotedOrder({ issuedAt: later(HOUR), expiresAt: later(HOUR + 3 * DAY) });
    const at = later(HOUR + 3 * DAY - 12 * HOUR);
    const buyer = createDatabase(f.scopedUrl); const gate = Promise.withResolvers<void>(); const accepted = Promise.withResolvers<void>();
    let acceptance: Promise<void> | undefined; let scanning: ReturnType<typeof run> | undefined; let blockerPid = 0;
    try {
      // The buyer's acceptance holds the order row until the scan is waiting on it, then commits.
      acceptance = buyer.db.transaction(async (tx) => {
        const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`); blockerPid = backend!.pid;
        await f.acceptQuote(tx, o, later(2 * HOUR)); accepted.resolve(); await gate.promise;
      });
      acceptance.catch(() => undefined); await Promise.race([accepted.promise, acceptance]);
      scanning = run(at); scanning.catch(() => undefined);
      await waitForLockWait(blockerPid);
      gate.resolve(); await acceptance;
      await scanning;
    } finally { gate.resolve(); await Promise.allSettled([acceptance, scanning]); await buyer.close(); }
    const [order] = await f.db.select().from(schema.commissionOrders).where(eq(schema.commissionOrders.id, o.orderId));
    expect(order!.state).toBe("awaiting_payment");
    expect(await reminders(o.orderId)).toEqual([]);
    expect(await ledger(o.orderId)).toEqual([]);
  });

  test("no missed notice when the respondent's response commits while the scan waits on the dispute", async () => {
    const o = await f.paidOrder(); const disputeId = await f.dispute(o, "buyer"); const respondBy = later(4_000 + 5 * DAY);
    // As addStatement does: lock the dispute, insert the response, never update the dispute row itself.
    await actWhileScanning(shift(respondBy, HOUR), async (tx) => {
      await tx.select({ id: schema.commissionDisputes.id }).from(schema.commissionDisputes).where(eq(schema.commissionDisputes.id, disputeId)).for("update");
      await f.statement(disputeId, o.creator.userId, "creator", "response", tx);
    });
    expect(await reminders(disputeId)).toEqual([]);
    expect(await ledger(disputeId)).toEqual([]);
  });

  test("no appeal-window reminder when an appeal commits while the scan waits on the penalty", async () => {
    const owner = await f.owner(); const subject = await f.person();
    const penaltyId = await f.penalty(subject, "restriction", owner, null);
    // As the appeal service does: lock the penalty, insert the appeal, never update the penalty row itself.
    await actWhileScanning(later(13_000 + 14 * DAY - 12 * HOUR), async (tx) => {
      await tx.select({ id: schema.trustPenalties.id }).from(schema.trustPenalties).where(eq(schema.trustPenalties.id, penaltyId)).for("update");
      await f.appeal(subject, { penaltyId }, tx);
    });
    expect(await reminders(penaltyId)).toEqual([]);
    expect(await ledger(penaltyId)).toEqual([]);
  });

  test("pause moves the deadline and re-arms one reminder", async () => {
    const o = await f.paidOrder(); const id = await f.proposal(o, "buyer"); const respondBy = later(2_000 + 72 * HOUR);
    const pause = { open: false, extendMs: 0 };
    const deadlines: NotificationDeadlinePort = { ...passThrough, resolution: async (_tx, deadline) => pause.open ? null : shift(deadline, pause.extendMs) };
    await run(shift(respondBy, -12 * HOUR), { deadlines });
    expect(await reminders(id)).toHaveLength(1);
    pause.open = true;
    await run(shift(respondBy, -HOUR), { deadlines }); await run(shift(respondBy, HOUR), { deadlines });
    expect(await reminders(id)).toHaveLength(1);
    // The pause ended and moved the deadline 48 hours later; its 24-hour window opens at respondBy + 24 hours.
    pause.open = false; pause.extendMs = 48 * HOUR;
    await run(shift(respondBy, 20 * HOUR), { deadlines });
    expect(await reminders(id)).toHaveLength(1);
    await run(shift(respondBy, 36 * HOUR), { deadlines }); await run(shift(respondBy, 40 * HOUR), { deadlines });
    const found = await reminders(id);
    expect(found.map((item) => [item.recipientUserId, item.kind, item.variant])).toEqual([
      [o.creator.userId, "reminder_due", "proposal_response"], [o.creator.userId, "reminder_due", "proposal_response"]]);
    expect((await ledger(id)).map((row) => [row.stage, row.effectiveDeadline])).toEqual([["due_24h", respondBy], ["due_24h", shift(respondBy, 48 * HOUR)]]);
  });

  test("owner deadline extension re-arms", async () => {
    const o = await f.paidOrder(); const id = await f.dispute(o, "buyer"); const respondBy = later(4_000 + 5 * DAY);
    await run(shift(respondBy, -12 * HOUR));
    expect(await reminders(id)).toHaveLength(1);
    const extended = shift(respondBy, 3 * DAY);
    await f.db.update(schema.commissionDisputes).set({ respondBy: extended, version: 2 }).where(eq(schema.commissionDisputes.id, id));
    // The old deadline has passed, but the clock now runs to the extended one: nothing is missed.
    await run(shift(respondBy, HOUR));
    expect(await reminders(id)).toHaveLength(1);
    await run(shift(extended, -12 * HOUR));
    expect((await reminders(id)).map((item) => [item.recipientUserId, item.kind])).toEqual([[o.creator.userId, "reminder_due"], [o.creator.userId, "reminder_due"]]);
    expect((await ledger(id)).map((row) => [row.stage, row.effectiveDeadline])).toEqual([["due_24h", respondBy], ["due_24h", extended]]);
  });

  test("resend_required restarts the refund-send clock", async () => {
    const o = await f.paidOrder(); const id = await f.refundObligation(o);
    const firstDue = later(60_000 + 5 * DAY);
    await f.refundAwaitingSend(id, { enteredAt: later(60_000), dueAt: firstDue });
    await run(shift(firstDue, -12 * HOUR));
    await f.refundSent(id, shift(firstDue, -HOUR));
    const resentAt = shift(firstDue, DAY); const secondDue = shift(resentAt, 5 * DAY);
    await f.refundResend(id, { deniedAt: shift(firstDue, 12 * HOUR), at: resentAt, dueAt: secondDue });
    const open = await f.db.transaction((tx) => readOpenClocks(tx, { clock: "refund_send", now: shift(secondDue, -12 * HOUR), limit: 200, deadlines: passThrough }));
    expect(open.find((clock) => clock.subjectId === id)).toMatchObject({ startedAt: resentAt, effectiveDeadline: secondDue, recipients: [{ userId: o.creator.userId, role: "creator" }] });
    await run(shift(secondDue, -12 * HOUR));
    const found = (await reminders(id)).filter((item) => item.variant === "refund_send");
    expect(found.map((item) => [item.recipientUserId, item.kind])).toEqual([[o.creator.userId, "reminder_due"], [o.creator.userId, "reminder_due"]]);
    expect((await ledger(id)).filter((row) => row.clock === "refund_send").map((row) => row.effectiveDeadline)).toEqual([firstDue, secondDue]);
  });

  test("running twice creates nothing new", async () => {
    const o = await f.requestedOrder({ expiresAt: later(4 * DAY) });
    const first = await run(later(4 * DAY - 20 * HOUR));
    expect(first.result.remindersCreated).toBeGreaterThanOrEqual(1);
    const again = await run(later(4 * DAY - 20 * HOUR)); await run(later(4 * DAY - 2 * HOUR));
    expect(again.calls.filter((call) => call.linkPath.endsWith(o.orderId))).toEqual([]);
    expect(await reminders(o.orderId)).toHaveLength(1);
    expect(await ledger(o.orderId)).toHaveLength(1);
  });

  test("enabling picks up an open clock once", async () => {
    const o = await f.paidOrder(); const due = later(1_000 + 7 * DAY);
    const disabled = await run(shift(due, -12 * HOUR), { mode: "disabled" });
    expect(disabled.result).toEqual({ digestsQueued: 0, digestsDeferred: 0, digestsSuppressed: 0, digestsFailed: 0, remindersCreated: 0, remindersFailed: 0, deleted: 0 });
    expect(await reminders(o.orderId)).toEqual([]); expect(await ledger(o.orderId)).toEqual([]);
    await run(shift(due, -11 * HOUR)); await run(shift(due, -10 * HOUR));
    expect(await reminders(o.orderId)).toHaveLength(1);
    expect(await ledger(o.orderId)).toHaveLength(1);
  });

  test("appeal window reminder is informational and skips suspensions", async () => {
    const owner = await f.owner(); const subject = await f.person();
    const restriction = await f.penalty(subject, "restriction", owner, null);
    const suspension = await f.penalty(subject, "suspension", owner);
    const removal = await f.penalty(await f.person(), "removal", owner);
    const warning = await f.penalty(await f.person(), "warning", owner);
    const appealedSubject = await f.person();
    const appealed = await f.penalty(appealedSubject, "restriction", owner, later(30 * DAY));
    await f.appeal(appealedSubject, { penaltyId: appealed });
    const ended = await f.penalty(await f.person(), "restriction", owner, later(2 * DAY));
    await run(later(13_000 + 14 * DAY - 12 * HOUR));
    expect(await reminders(restriction)).toMatchObject([{ recipientUserId: subject, kind: "reminder_due", variant: "appeal_window", category: "moderation",
      actionRequired: false, subjectType: "trust_penalty", subjectId: restriction, linkPath: "/help/cases", emailState: "queued" }]);
    for (const skipped of [suspension, removal, warning, appealed, ended]) expect(await reminders(skipped)).toEqual([]);
    // An informational reminder respects the moderation email opt-out; the in-app item remains.
    const optedOut = await f.person(); await f.optOut(optedOut, "moderation");
    const other = await f.penalty(optedOut, "restriction", owner, null);
    await run(later(13_000 + 14 * DAY - 6 * HOUR));
    expect(await reminders(other)).toMatchObject([{ recipientUserId: optedOut, actionRequired: false, emailState: "suppressed", emailHandoffId: null }]);
    // The window is over at the deadline; nothing is "missed".
    await run(later(13_000 + 15 * DAY));
    expect(await reminders(restriction)).toHaveLength(1);
  });

  test("a failing candidate does not stop the batch", async () => {
    const broken = await f.paidOrder(); const healthy = await f.paidOrder(); const due = later(1_000 + 7 * DAY);
    const proposalOrder = await f.paidOrder(); const proposalId = await f.proposal(proposalOrder, "buyer");
    const inner = createTestEmailPort();
    const email: NotificationEmailPort = { async queue(tx, notice) {
      if (notice.userId === broken.creator.userId) throw new Error("synthetic email failure");
      return inner.port.queue(tx, notice);
    } };
    const deadlines: NotificationDeadlinePort = { ...passThrough, resolution: async () => { throw new Error("synthetic deadline failure"); } };
    const failures: NotificationMaintenanceFailure[] = [];
    const { result } = await run(shift(due, -12 * HOUR), { email, deadlines, failures });
    expect(result.remindersFailed).toBeGreaterThanOrEqual(2);
    expect(failures).toEqual(expect.arrayContaining([{ step: "reminder", clock: "delivery_due", subjectId: broken.orderId },
      { step: "reminder", clock: "proposal_response", subjectId: proposalId }]));
    expect(JSON.stringify(failures)).not.toContain("synthetic");
    // The failed candidate rolled back entirely, so the next run retries it.
    expect(await reminders(broken.orderId)).toEqual([]); expect(await ledger(broken.orderId)).toEqual([]);
    expect(await reminders(healthy.orderId)).toHaveLength(1);
    await run(shift(due, -11 * HOUR));
    expect(await reminders(broken.orderId)).toHaveLength(1);
    await run(later(2_000 + 60 * HOUR));
    expect(await reminders(proposalId)).toHaveLength(1);
  });
});

/** Runs `action` on a second connection and holds its transaction open until the scan at `at` is blocked on its lock, then commits. */
async function actWhileScanning(at: Date, action: (tx: Parameters<Parameters<typeof f.db.transaction>[0]>[0]) => Promise<void>) {
  const other = createDatabase(f.scopedUrl); const gate = Promise.withResolvers<void>(); const held = Promise.withResolvers<void>();
  let acting: Promise<void> | undefined; let scanning: ReturnType<typeof run> | undefined; let blockerPid = 0;
  try {
    acting = other.db.transaction(async (tx) => {
      const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`); blockerPid = backend!.pid;
      await action(tx); held.resolve(); await gate.promise;
    });
    acting.catch(() => undefined); await Promise.race([held.promise, acting]);
    scanning = run(at); scanning.catch(() => undefined);
    await waitForLockWait(blockerPid);
    gate.resolve(); await acting;
    await scanning;
  } finally { gate.resolve(); await Promise.allSettled([acting, scanning]); await other.close(); }
}

/** Waits until the scan's locked re-read is blocked on the other session's row lock. */
async function waitForLockWait(blockerPid: number) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    // Match this action's backend, so another waiting query cannot release the gate early.
    const rows = await f.db.execute(sql`select count(*)::int as waiting from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock' and ${blockerPid} = any(pg_blocking_pids(pid))`);
    if (Number((rows as unknown as { waiting: number }[])[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the scan never waited on the subject row");
}

