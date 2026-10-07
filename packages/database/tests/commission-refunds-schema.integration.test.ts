import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createCommissionResolutionTestFixture } from "../../../apps/web/tests/commission-resolution-test-support.js";
import { fixtureEnvelope } from "../../payments/tests/sepay-integration-fixture.js";
import { importConfiguredBusinessCalendarVersion } from "@pawket/database";

const parsed = new URL(process.env.TEST_DATABASE_URL ?? "invalid:");
if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || !/test|ci/iu.test(parsed.pathname)) {
  throw new Error("Refund schema tests require a dedicated local test database");
}
const fixture = createCommissionResolutionTestFixture("refund_schema");
beforeAll(async () => {
  await fixture.initialize();
  await fixture.db.transaction((tx) => importConfiguredBusinessCalendarVersion(tx, { version: "vn-test", holidayDates: [] }));
}, 30_000); afterAll(fixture.dispose, 30_000);
const at = "2026-10-09T04:00:00Z";
const end = "2026-10-16T04:00:00Z";
async function refused(operation: PromiseLike<unknown>, code = "23514") {
  try { await operation; } catch (error) { expect(error).toMatchObject({ code }); return; }
  throw new Error(`Expected SQLSTATE ${code}`);
}
async function obligation(sourceId = randomUUID()) {
  const p = await fixture.paidOrder(); const id = randomUUID();
  await fixture.client`insert into commission_refund_obligations
    (id, order_id, payment_intent_id, creator_user_id, buyer_user_id, source, source_id, amount_vnd, reference, calendar_version, created_at, updated_at)
    values (${id}, ${p.orderId}, ${p.confirmationCommand.paymentIntentId}, ${p.creator.userId}, ${p.buyer.userId}, 'agreement',
      ${sourceId}, 500000, ${`PKR${id.replaceAll("-", "").slice(0, 12).toUpperCase()}`}, 'vn-test', ${at}, ${at})`;
  return { id, p, sourceId };
}
async function destination(id: string) {
  const account = fixtureEnvelope("commission_refund_obligation", id, "account_number", "000000123456");
  const holder = fixtureEnvelope("commission_refund_obligation", id, "holder_name", "SYNTHETIC BUYER");
  await fixture.client`update commission_refund_obligations set state = 'awaiting_send', destination_bank_bin = '970436',
    destination_bank_name = 'Vietcombank', destination_account_envelope = ${JSON.stringify(account)}::jsonb,
    destination_holder_envelope = ${JSON.stringify(holder)}::jsonb, destination_suffix = '3456', destination_entered_at = ${at},
    due_at = '2026-10-16T16:59:59.999Z', version = version + 1 where id = ${id}`;
}
async function sent(c: Awaited<ReturnType<typeof obligation>>) {
  await destination(c.id); const sendId = randomUUID();
  const envelope = fixtureEnvelope("commission_refund_send", sendId, "bank_reference", "SYNTHETIC-1");
  await fixture.client.begin(async (tx) => {
    await tx`insert into commission_refund_sends (id, obligation_id, transfer_date, reference_envelope, actor_user_id, actor_session_id, request_id, recorded_at)
      values (${sendId}, ${c.id}, '2026-10-09', ${JSON.stringify(envelope)}::jsonb, ${c.p.creator.userId}, ${c.p.creator.sessionId}, ${randomUUID()}, ${at})`;
    await tx`update commission_refund_obligations set state = 'sent', current_send_id = ${sendId}, confirm_by = ${end}, version = version + 1 where id = ${c.id}`;
  });
  return sendId;
}
describe("commission refund database boundaries", () => {
  test.each(["awaiting_destination", "awaiting_send", "sent", "not_received", "received", "presumed_received", "waived"])("%s column rules are enforced", async (state) => {
    const c = await obligation();
    if (state === "awaiting_destination") {
      await refused(fixture.client`update commission_refund_obligations set due_at = ${end}, version = version + 1 where id = ${c.id}`);
    } else if (state === "awaiting_send") {
      await destination(c.id);
      await refused(fixture.client`update commission_refund_obligations set due_at = null, version = version + 1 where id = ${c.id}`);
      await refused(fixture.client`update commission_refund_obligations set destination_account_envelope = null, version = version + 1 where id = ${c.id}`);
    } else if (state === "waived") {
      await refused(fixture.client`update commission_refund_obligations set state = 'waived', version = version + 1 where id = ${c.id}`);
      await fixture.client`update commission_refund_obligations set state = 'waived', ended_at = ${end}, version = version + 1 where id = ${c.id}`;
    } else {
      await sent(c);
      if (state === "not_received") await fixture.client`update commission_refund_obligations set state = 'not_received', version = version + 1 where id = ${c.id}`;
      if (state === "received" || state === "presumed_received") {
        await refused(fixture.client`update commission_refund_obligations set state = ${state}, version = version + 1 where id = ${c.id}`);
        await fixture.client`update commission_refund_obligations set state = ${state}, ended_at = ${end}, version = version + 1 where id = ${c.id}`;
      } else {
        await refused(fixture.client`update commission_refund_obligations set current_send_id = null, version = version + 1 where id = ${c.id}`);
        await refused(fixture.client`update commission_refund_obligations set confirm_by = null, version = version + 1 where id = ${c.id}`);
      }
    }
  });
  test("the state graph refuses sent to awaiting_destination", async () => {
    const c = await obligation(); await sent(c);
    await refused(fixture.client`update commission_refund_obligations set state = 'awaiting_destination', current_send_id = null, confirm_by = null,
      due_at = null, destination_bank_bin = null, destination_bank_name = null, destination_account_envelope = null,
      destination_holder_envelope = null, destination_suffix = null, destination_entered_at = null, version = version + 1 where id = ${c.id}`);
  });
  test("events and sends cannot be updated or deleted", async () => {
    const c = await obligation(); const sendId = await sent(c); const eventId = randomUUID();
    await fixture.client`insert into commission_refund_events (id, obligation_id, action, from_state, to_state, request_id, occurred_at)
      values (${eventId}, ${c.id}, 'created', null, 'awaiting_destination', ${randomUUID()}, ${at})`;
    await refused(fixture.client`update commission_refund_events set request_id = ${randomUUID()} where id = ${eventId}`);
    await refused(fixture.client`delete from commission_refund_events where id = ${eventId}`);
    await refused(fixture.client`update commission_refund_sends set request_id = ${randomUUID()} where id = ${sendId}`);
    await refused(fixture.client`delete from commission_refund_sends where id = ${sendId}`);
  });
  test("one obligation per source", async () => {
    const c = await obligation(); await refused(obligation(c.sourceId), "23505");
  });
  test("identity, amount, reference and version are guarded", async () => {
    const c = await obligation();
    await refused(fixture.client`update commission_refund_obligations set source_id = ${randomUUID()}, version = version + 1 where id = ${c.id}`);
    await refused(fixture.client`update commission_refund_obligations set version = version + 2 where id = ${c.id}`);
    await refused(fixture.client`update commission_refund_obligations set amount_vnd = 0, version = version + 1 where id = ${c.id}`);
    await refused(fixture.client`update commission_refund_obligations set reference = 'INVALID', version = version + 1 where id = ${c.id}`);
    await refused(fixture.client`delete from commission_refund_obligations where id = ${c.id}`);
  });
});
