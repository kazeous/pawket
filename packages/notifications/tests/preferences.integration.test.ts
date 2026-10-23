import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { identityRoleGrants, notificationPreferences, notifications } from "@pawket/database";
import { createNotificationInbox } from "../src/inbox-service.js";
import type { OptionalEmailCategory } from "../src/catalog.js";
import { createNotificationMaterializer } from "../src/materializer.js";
import { createNotificationFixture, createTestEmailPort } from "./notification-fixture.js";

const f = createNotificationFixture("preferences");
beforeAll(f.initialize, 60_000); afterAll(f.dispose, 30_000);
const at = new Date("2026-10-12T03:00:00Z");
const inbox = () => createNotificationInbox({ db: f.db, mode: "enabled", now: () => at });
const preference = (category: OptionalEmailCategory = "orders", enabled = false) => ({ channel: "email" as const, category, enabled, at });
const rows = (userId: string) => f.db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId));

test("defaults are all on", async () => {
  const user = await f.person(); const service = inbox();
  await expect(service.readPreferences(user)).resolves.toEqual({ owner: false, email: {
    orders: true, messages: true, deliveries: true, disputes_refunds: true, moderation: true,
  } });
  const owner = await f.owner();
  await expect(service.readPreferences(owner)).resolves.toMatchObject({ owner: true, email: { owner_queue: true } });
  await service.setPreference(owner, { ...preference(), category: "owner_queue" });
  await expect(service.readPreferences(owner)).resolves.toMatchObject({ owner: true, email: { owner_queue: false } });
  await f.db.update(identityRoleGrants).set({ state: "revoked", revokedAt: at }).where(eq(identityRoleGrants.userId, owner));
  const revoked = await service.readPreferences(owner); expect(revoked.owner).toBe(false); expect(revoked.email).not.toHaveProperty("owner_queue");
});
test("turning orders off then on leaves no row", async () => {
  const user = await f.person(); const other = await f.person(); const service = inbox();
  await service.setPreference(other, preference());
  for (let repeat = 0; repeat < 2; repeat++) await service.setPreference(user, preference());
  expect(await rows(user)).toHaveLength(1); expect((await service.readPreferences(user)).email.orders).toBe(false);
  for (let repeat = 0; repeat < 2; repeat++) await service.setPreference(user, preference("orders", true));
  expect(await rows(user)).toEqual([]); expect((await service.readPreferences(user)).email.orders).toBe(true); expect(await rows(other)).toHaveLength(1);
});
test("owner_queue is refused for a non-owner", async () => {
  const user = await f.person(); const service = inbox();
  for (const enabled of [false, true]) await expect(service.setPreference(user, { ...preference(), category: "owner_queue", enabled })).rejects.toMatchObject({ code: "invalid_request" });
  expect(await rows(user)).toEqual([]);
});
test("a change applies to notices created afterwards only", async () => {
  const order = await f.paidOrder(); const email = createTestEmailPort(); const service = inbox();
  const materializer = createNotificationMaterializer({ db: f.db, mode: "enabled", email: email.port, now: () => at });
  async function emit() {
    const source = await f.outbox("commission.completed.v1", "commission_order", order.orderId,
      { orderId: order.orderId, version: 2, state: "completed", reason: null, correlationId: randomUUID() });
    await materializer.materialize({ outboxEventId: source.id, eventType: source.eventType, eventVersion: 1, aggregateType: source.aggregateType, aggregateId: source.aggregateId });
    const [item] = await f.db.select().from(notifications).where(and(eq(notifications.sourceKey, source.id), eq(notifications.recipientUserId, order.buyer.userId)));
    return item!;
  }
  const before = await emit(); expect(before.emailState).toBe("queued");
  await service.setPreference(order.buyer.userId, preference());
  expect((await emit()).emailState).toBe("suppressed");
  const [unchanged] = await f.db.select().from(notifications).where(eq(notifications.id, before.id));
  expect(unchanged!.emailState).toBe("queued"); expect(unchanged!.emailHandoffId).toBe(before.emailHandoffId);
  await service.setPreference(order.buyer.userId, preference("orders", true));
  expect((await emit()).emailState).toBe("queued");
});
test("disabled preferences neither read nor write", async () => {
  const user = await f.person(); const service = createNotificationInbox({ db: f.db, mode: "disabled" });
  await expect(service.readPreferences(user)).rejects.toMatchObject({ code: "not_available" });
  await expect(service.setPreference(user, preference())).rejects.toMatchObject({ code: "not_available" }); expect(await rows(user)).toEqual([]);
});
