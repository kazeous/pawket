import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as schema from "@pawket/database";
import { createNotificationMaintenance } from "../src/maintenance.js";
import { NOTIFICATION_POLICY } from "../src/policy.js";
import type { NotificationDeadlinePort } from "../src/ports.js";
import { createNotificationFixture, createTestEmailPort } from "./notification-fixture.js";

const f = createNotificationFixture("retention");
beforeAll(f.initialize, 60_000); afterAll(f.dispose, 30_000);

// One clock for the whole file: rows a test keeps stay young for the next test.
const now = new Date("2027-03-01T00:00:00Z");
const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY);
const deadlines: NotificationDeadlinePort = {
  resolution: async () => { throw new Error("unused"); }, completion: async () => { throw new Error("unused"); }, enforcement: async () => { throw new Error("unused"); },
};
function maintenance(batch?: number) {
  const email = createTestEmailPort();
  return { service: createNotificationMaintenance({ db: f.db, mode: "enabled", email: email.port, deadlines, now: () => now, batch }), calls: email.calls };
}

async function item(userId: string, createdAt: Date, options: { read?: boolean; handoffId?: string } = {}) {
  const id = randomUUID();
  await f.db.insert(schema.notifications).values({ id, recipientUserId: userId, kind: "order_completed", category: "orders", actionRequired: false,
    subjectType: "commission_order", subjectId: randomUUID(), linkPath: `/commissions/${randomUUID()}`, sourceKey: randomUUID(),
    emailState: options.handoffId ? "queued" : "none", emailHandoffId: options.handoffId ?? null, emailQueuedAt: options.handoffId ? createdAt : null,
    createdAt, updatedAt: createdAt, readAt: options.read ? new Date(createdAt.getTime() + 60_000) : null });
  return id;
}
async function handoff(userId: string, at: Date) {
  const id = randomUUID();
  await f.db.insert(schema.identityEmailHandoffs).values({ id, purpose: "notification", userId, status: "attention_required", destinationEnvelope: null,
    failureCode: "no_verified_destination", templateData: { kind: "order_completed", variant: "", category: "orders", linkPath: "/creator" }, availableAt: at, createdAt: at, updatedAt: at });
  return id;
}
async function reminder(effectiveDeadline: Date) {
  const id = randomUUID();
  await f.db.insert(schema.notificationReminders).values({ id, subjectType: "commission_order", subjectId: randomUUID(), clock: "payment", stage: "due_24h",
    effectiveDeadline, createdAt: new Date(effectiveDeadline.getTime() - DAY) });
  return id;
}
const itemIds = async (ids: readonly string[]) => (await f.db.select({ id: schema.notifications.id }).from(schema.notifications)
  .where(inArray(schema.notifications.id, [...ids]))).map((row) => row.id).sort();
const reminderIds = async (ids: readonly string[]) => (await f.db.select({ id: schema.notificationReminders.id }).from(schema.notificationReminders)
  .where(inArray(schema.notificationReminders.id, [...ids]))).map((row) => row.id).sort();

describe("notification retention", () => {
  test("items older than 90 days are deleted, read or not", async () => {
    expect(NOTIFICATION_POLICY.retentionMs).toBe(90 * DAY);
    const user = await f.person();
    const sentHandoff = await handoff(user, daysAgo(91));
    const oldUnread = await item(user, daysAgo(91)); const oldRead = await item(user, daysAgo(120), { read: true });
    const oldEmailed = await item(user, daysAgo(90.01), { handoffId: sentHandoff });
    const young = await item(user, daysAgo(89)); const edge = await item(user, daysAgo(90));
    const run = maintenance();
    await expect(run.service.runOnce()).resolves.toEqual({ digestsQueued: 0, digestsDeferred: 0, digestsSuppressed: 0, digestsFailed: 0, remindersCreated: 0, remindersFailed: 0, deleted: 3 });
    expect(await itemIds([oldUnread, oldRead, oldEmailed, young, edge])).toEqual([young, edge].sort());
    // Email handoffs keep their own retention.
    expect(await f.db.select({ id: schema.identityEmailHandoffs.id }).from(schema.identityEmailHandoffs).where(eq(schema.identityEmailHandoffs.id, sentHandoff)))
      .toEqual([{ id: sentHandoff }]);
    expect(run.calls).toEqual([]);
  });

  test("reminder rows 90 days past their deadline are deleted", async () => {
    const old = await reminder(daysAgo(91)); const older = await reminder(daysAgo(400));
    const young = await reminder(daysAgo(89)); const future = await reminder(new Date(now.getTime() + DAY));
    await expect(maintenance().service.runOnce()).resolves.toEqual({ digestsQueued: 0, digestsDeferred: 0, digestsSuppressed: 0, digestsFailed: 0, remindersCreated: 0, remindersFailed: 0, deleted: 2 });
    expect(await reminderIds([old, older, young, future])).toEqual([young, future].sort());
  });

  test("deletion is batched", async () => {
    const user = await f.person();
    const items = [] as string[]; for (let index = 0; index < 5; index += 1) items.push(await item(user, daysAgo(100 + index)));
    const reminders = [] as string[]; for (let index = 0; index < 3; index += 1) reminders.push(await reminder(daysAgo(100 + index)));
    const run = maintenance(2);
    await expect(run.service.runOnce()).resolves.toMatchObject({ deleted: 4 });
    expect(await itemIds(items)).toHaveLength(3); expect(await reminderIds(reminders)).toHaveLength(1);
    await expect(run.service.runOnce()).resolves.toMatchObject({ deleted: 3 });
    expect(await itemIds(items)).toHaveLength(1); expect(await reminderIds(reminders)).toHaveLength(0);
    await expect(run.service.runOnce()).resolves.toMatchObject({ deleted: 1 });
    await expect(run.service.runOnce()).resolves.toMatchObject({ deleted: 0 });
    expect(await itemIds(items)).toEqual([]);
  });

  test("disabled maintenance deletes nothing", async () => {
    const user = await f.person(); const old = await item(user, daysAgo(200)); const oldReminder = await reminder(daysAgo(200));
    const service = createNotificationMaintenance({ db: f.db, mode: "disabled", email: createTestEmailPort().port, deadlines, now: () => now });
    await expect(service.runOnce()).resolves.toEqual({ digestsQueued: 0, digestsDeferred: 0, digestsSuppressed: 0, digestsFailed: 0, remindersCreated: 0, remindersFailed: 0, deleted: 0 });
    expect(await itemIds([old])).toEqual([old]); expect(await reminderIds([oldReminder])).toEqual([oldReminder]);
    await expect(maintenance().service.runOnce()).resolves.toMatchObject({ deleted: 2 });
  });

  test("an invalid batch is refused", () => {
    for (const batch of [0, -1, 1.5, 501]) {
      expect(() => createNotificationMaintenance({ db: f.db, mode: "enabled", email: createTestEmailPort().port, deadlines, batch })).toThrow();
    }
  });
});
