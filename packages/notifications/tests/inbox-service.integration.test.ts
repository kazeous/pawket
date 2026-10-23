import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as schema from "@pawket/database";
import { createNotificationInbox } from "../src/inbox-service.js";
import { renderNotice } from "../src/copy.js";
import { NOTIFICATION_POLICY, NotificationError } from "../src/policy.js";
import { createNotificationFixture } from "./notification-fixture.js";

const f = createNotificationFixture("inbox");
beforeAll(f.initialize, 60_000); afterAll(f.dispose, 30_000);

const T = new Date("2026-10-05T03:00:00Z");
const now = new Date("2026-10-06T03:00:00Z");
const inbox = () => createNotificationInbox({ db: f.db, mode: "enabled", now: () => now });

type ItemOptions = { kind?: string; variant?: string | null; actionRequired?: boolean; read?: boolean; orderId?: string;
  messages?: boolean; count?: number; createdAt?: Date; updatedAt?: Date | string };
async function item(userId: string, options: ItemOptions = {}) {
  const id = randomUUID(); const orderId = options.orderId ?? randomUUID(); const createdAt = options.createdAt ?? T;
  const updatedAt = options.updatedAt === undefined ? createdAt
    : typeof options.updatedAt === "string" ? sql`${options.updatedAt}::timestamptz` : options.updatedAt;
  await f.db.insert(schema.notifications).values({ id, recipientUserId: userId, kind: options.kind ?? (options.messages ? "order_messages" : "order_completed"),
    variant: options.variant ?? null, category: options.messages ? "messages" : "orders", actionRequired: options.actionRequired ?? false,
    subjectType: "commission_order", subjectId: orderId, linkPath: `/commissions/${orderId}`,
    collapseKey: options.messages ? `messages:${orderId}` : null, collapsedCount: options.count ?? 1, lastSequence: options.messages ? 1 : null,
    sourceKey: randomUUID(), emailState: options.messages ? "pending" : "none", emailDueAt: options.messages ? new Date(createdAt.getTime() + 900_000) : null,
    createdAt, updatedAt, readAt: options.read ? new Date(createdAt.getTime() + 60_000) : null });
  return id;
}
const row = async (id: string) => (await f.db.select().from(schema.notifications).where(eq(schema.notifications.id, id)))[0]!;

describe("notification inbox", () => {
  test("list is newest first, paged by 30 and only the recipient's items", async () => {
    expect(NOTIFICATION_POLICY.inboxPageSize).toBe(30);
    const user = await f.person(); const other = await f.person();
    // 33 items whose updated_at differ only in microseconds, including ties broken by id, so the cursor must keep
    // full timestamp precision across the page boundary.
    const ids: string[] = [];
    for (let index = 0; index < 33; index += 1) {
      const micros = String(100_000 + Math.floor(index / 3)).padStart(6, "0");
      ids.push(await item(user, { updatedAt: `2026-10-05T04:00:00.${micros}Z`, createdAt: T }));
    }
    const action = await item(user, { kind: "order_closed", variant: "payment_expired", actionRequired: true, createdAt: T, updatedAt: new Date("2026-10-05T05:00:00Z") });
    const collapsed = await item(user, { messages: true, count: 4, read: true, createdAt: new Date("2026-10-05T02:00:00Z"), updatedAt: new Date("2026-10-05T06:00:00Z") });
    await item(other, { updatedAt: new Date("2026-10-05T07:00:00Z") });
    const service = inbox();
    const first = await service.list(user, null);
    expect(first.items).toHaveLength(30);
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    const second = await service.list(user, first.nextCursor);
    expect(second.items).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    const all = [...first.items, ...second.items];
    expect(new Set(all.map((entry) => entry.id)).size).toBe(35);
    // Newest updated_at first, then id descending within one timestamp.
    const expectedTail = ids.map((id, index) => ({ id, micros: Math.floor(index / 3) }))
      .sort((a, b) => b.micros - a.micros || (a.id < b.id ? 1 : -1)).map((entry) => entry.id);
    expect(all.map((entry) => entry.id)).toEqual([collapsed, action, ...expectedTail]);
    const closedCopy = renderNotice("order_closed", "payment_expired");
    expect(all[1]).toEqual({ id: action, kind: "order_closed", variant: "payment_expired", title: closedCopy.title, body: closedCopy.body,
      actionLabel: closedCopy.actionLabel, actionRequired: true, linkPath: expect.stringMatching(/^\/commissions\//u), count: 1, createdAt: T.toISOString(), read: false });
    expect(all[0]).toMatchObject({ id: collapsed, kind: "order_messages", variant: null, count: 4, read: true, createdAt: "2026-10-05T02:00:00.000Z",
      title: renderNotice("order_messages", null).title });
    // A forged or damaged cursor is refused.
    await expect(service.list(user, "not a cursor")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(service.list(user, Buffer.from("{}").toString("base64url"))).rejects.toMatchObject({ code: "invalid_request" });
    // Another user sees only their own item.
    const theirs = await service.list(other, null);
    expect(theirs.items).toHaveLength(1); expect(theirs.nextCursor).toBeNull();
  });

  test("summary counts unread and caps at 99", async () => {
    expect(NOTIFICATION_POLICY.unreadCap).toBe(99);
    const user = await f.person(); const service = inbox();
    await expect(service.summary(user)).resolves.toEqual({ unread: 0 });
    await item(user); await item(user); await item(user, { read: true }); await item(user, { messages: true, count: 7 });
    await expect(service.summary(user)).resolves.toEqual({ unread: 3 });
    const busy = await f.person();
    for (let index = 0; index < 101; index += 1) await item(busy);
    await expect(service.summary(busy)).resolves.toEqual({ unread: 99 });
  });

  test("mark all read", async () => {
    const user = await f.person(); const other = await f.person(); const service = inbox();
    const a = await item(user); const b = await item(user, { messages: true }); const theirs = await item(other);
    await expect(service.markRead(user, { all: true })).resolves.toBe(2);
    await expect(service.summary(user)).resolves.toEqual({ unread: 0 });
    expect(await row(a)).toMatchObject({ readAt: now });
    expect(await row(b)).toMatchObject({ readAt: now, emailState: "suppressed", emailDueAt: null });
    expect(await row(theirs)).toMatchObject({ readAt: null });
  });

  test("mark by order clears only that order's message item", async () => {
    const user = await f.person(); const service = inbox(); const orderId = randomUUID(); const otherOrder = randomUUID();
    const message = await item(user, { messages: true, orderId }); const status = await item(user, { orderId });
    const elsewhere = await item(user, { messages: true, orderId: otherOrder });
    await expect(service.markRead(user, { orderId })).resolves.toBe(1);
    expect(await row(message)).toMatchObject({ readAt: now, emailState: "suppressed" });
    expect(await row(status)).toMatchObject({ readAt: null });
    expect(await row(elsewhere)).toMatchObject({ readAt: null, emailState: "pending" });
    await expect(service.summary(user)).resolves.toEqual({ unread: 2 });
  });

  test("ids belonging to another user are ignored", async () => {
    const user = await f.person(); const other = await f.person(); const service = inbox();
    const mine = await item(user); const theirs = await item(other);
    await expect(service.markRead(user, { ids: [mine, theirs] })).resolves.toBe(1);
    expect(await row(mine)).toMatchObject({ readAt: now });
    expect(await row(theirs)).toMatchObject({ readAt: null });
    expect((await service.list(user, null)).items.find((entry) => entry.id === mine)).toMatchObject({ read: true });
  });

  test("disabled throws not_available", async () => {
    const user = await f.person(); const id = await item(user);
    const service = createNotificationInbox({ db: f.db, mode: "disabled", now: () => now });
    for (const call of [() => service.list(user, null), () => service.summary(user), () => service.markRead(user, { all: true })]) {
      const error = await call().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(NotificationError); expect(error).toMatchObject({ code: "not_available" });
    }
    expect(await row(id)).toMatchObject({ readAt: null });
  });
});
