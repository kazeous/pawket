import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { effectiveResolutionDeadline } from "../../resolutions/src/deadlines.js";
import { createCommissionResolutionTestFixture } from "../../../apps/web/tests/commission-resolution-test-support.js";
import { fixtureEnvelope } from "../../payments/tests/sepay-integration-fixture.js";

const parsed = new URL(process.env.TEST_DATABASE_URL ?? "invalid:");
if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || !/test|ci/iu.test(parsed.pathname)) {
  throw new Error("Resolution schema tests require a dedicated local test database");
}
const fixture = createCommissionResolutionTestFixture("resolution_schema");
beforeAll(fixture.initialize, 30_000); afterAll(fixture.dispose, 30_000);
const at = "2026-10-07T04:00:00Z";
const envelope = (type: string, id: string, field: string) => JSON.stringify(fixtureEnvelope(type, id, field, "Synthetic text"));
async function refused(operation: PromiseLike<unknown>, code = "23514") {
  try { await operation; } catch (error) { expect(error).toMatchObject({ code }); return; }
  throw new Error(`Expected SQLSTATE ${code}`);
}
async function proposal(orderId: string, userId: string, kind = "cancel_with_refund", state = "in_progress") {
  const id = randomUUID();
  await fixture.client`insert into commission_proposals (id, order_id, proposer_user_id, proposer_role, kind, refund_amount_vnd,
    note_envelope, order_state_at_creation, remaining_review_ms, respond_by, created_at, actor_session_id, request_id)
    values (${id}, ${orderId}, ${userId}, 'buyer', ${kind}, 1000, ${envelope("commission_proposals", id, "note")}::jsonb,
      ${state}, ${state === "delivered" ? 1000 : null}, '2026-10-10T04:00:00Z', ${at}, 'synthetic-session', ${randomUUID()})`;
  return id;
}
async function dispute(orderId: string, userId: string) {
  const id = randomUUID();
  await fixture.client`insert into commission_disputes (id, order_id, opener_user_id, opener_role, trigger, trigger_at, reason,
    requested_outcome, requested_refund_vnd, order_state_at_open, respond_by, opened_at)
    values (${id}, ${orderId}, ${userId}, 'buyer', 'overdue', ${at}, 'not_delivered', 'close', 1000,
      'in_progress', '2026-10-12T04:00:00Z', ${at})`;
  return id;
}
async function statement(disputeId: string, userId: string) {
  const id = randomUUID();
  await fixture.client`insert into commission_dispute_statements (id, dispute_id, author_user_id, author_role, kind, text_envelope,
    actor_session_id, request_id, created_at) values (${id}, ${disputeId}, ${userId}, 'buyer', 'statement',
    ${envelope("commission_dispute_statements", id, "text")}::jsonb, 'synthetic-session', ${randomUUID()}, ${at})`;
  return id;
}
async function ruling(disputeId: string, userId: string, policyId: string) {
  const id = randomUUID();
  await fixture.client`insert into commission_rulings (id, dispute_id, outcome, refund_amount_vnd, reasoning_envelope,
    policy_revision_id, owner_user_id, actor_session_id, step_up_proof_id, request_id, ruled_at)
    values (${id}, ${disputeId}, 'close', 1000, ${envelope("commission_rulings", id, "reasoning")}::jsonb,
      ${policyId}, ${userId}, 'synthetic-session', ${randomUUID()}, ${randomUUID()}, ${at})`;
  return id;
}
describe("resolution database boundaries", () => {
  test("SQL and TypeScript effective deadlines agree before, inside, open and chained resolution pauses", async () => {
    const pauses = [
      { startedAt: "2030-01-02T04:00:00Z", endedAt: "2030-01-03T04:00:00Z" },
      { startedAt: "2030-01-06T04:00:00Z", endedAt: "2030-01-07T04:00:00Z" },
      { startedAt: "2030-01-08T04:00:00Z", endedAt: "2030-01-10T04:00:00Z" },
      { startedAt: "2030-01-13T04:00:00Z", endedAt: null },
      { startedAt: "2030-01-20T04:00:00Z", endedAt: "2030-01-21T04:00:00Z" },
    ];
    const openId = randomUUID();
    try {
      // Insert out of chronological order to pin sorting in both implementations.
      for (const pause of [...pauses].reverse().sort((a, b) => Number(a.endedAt === null) - Number(b.endedAt === null))) {
        const id = pause.endedAt === null ? openId : randomUUID();
        await fixture.client`insert into commission_resolution_pauses (id, started_at) values (${id}, ${pause.startedAt})`;
        if (pause.endedAt !== null) await fixture.client`update commission_resolution_pauses set ended_at = ${pause.endedAt}, version = 2 where id = ${id}`;
      }
      for (const [deadline, expected] of [
        ["2030-01-01T04:00:00Z", "2030-01-01T04:00:00Z"],
        ["2030-01-02T04:00:00Z", "2030-01-05T04:00:00Z"],
        ["2030-01-02T16:00:00Z", "2030-01-05T04:00:00Z"],
        ["2030-01-03T04:00:00Z", "2030-01-03T04:00:00Z"],
        ["2030-01-04T04:00:00Z", "2030-01-04T04:00:00Z"],
        ["2030-01-06T04:00:00Z", "2030-01-12T04:00:00Z"],
        ["2030-01-11T04:00:00Z", "2030-01-11T04:00:00Z"],
        ["2030-01-12T04:00:00Z", "2030-01-12T04:00:00Z"],
        ["2030-01-13T04:00:00Z", null],
        ["2030-01-15T04:00:00Z", null],
      ]) {
        const [row] = await fixture.client<{ deadline: string | null }[]>`select commission_resolution_effective_deadline(${deadline}::timestamptz) as deadline`;
        const actual = row!.deadline === null ? null : new Date(row!.deadline);
        const ts = await fixture.db.transaction((tx) => effectiveResolutionDeadline(tx, new Date(deadline!)));
        expect(actual).toEqual(expected === null ? null : new Date(expected!));
        expect(actual).toEqual(ts);
      }
    } finally {
      await fixture.client`update commission_resolution_pauses set ended_at = '2030-01-14T04:00:00Z', version = 2 where id = ${openId} and ended_at is null`;
    }
  });
  test("a second pending proposal on one order fails", async () => {
    const p = await fixture.paidOrder(); await proposal(p.orderId, p.buyer.userId);
    await refused(proposal(p.orderId, p.buyer.userId), "23505");
  });
  test("complete_with_refund on in_progress fails", async () => {
    const p = await fixture.paidOrder(); await refused(proposal(p.orderId, p.buyer.userId, "complete_with_refund"));
  });
  test("a second open dispute fails", async () => {
    const p = await fixture.paidOrder(); await dispute(p.orderId, p.buyer.userId);
    await refused(dispute(p.orderId, p.buyer.userId), "23505");
  });
  test("an eleventh buyer statement fails", async () => {
    const p = await fixture.paidOrder(); const id = await dispute(p.orderId, p.buyer.userId);
    for (let i = 0; i < 10; i++) await statement(id, p.buyer.userId);
    await refused(statement(id, p.buyer.userId));
  });
  test("a correction after 30 days fails and the boundary is accepted", async () => {
    const p = await fixture.paidOrder(); const id = await ruling(await dispute(p.orderId, p.buyer.userId), p.creator.userId, p.s.policyId);
    const correction = (correctedAt: string) => {
      const correctionId = randomUUID();
      return fixture.client`insert into commission_ruling_corrections (id, ruling_id, refund_amount_vnd, reason_envelope,
        effect, owner_user_id, actor_session_id, step_up_proof_id, request_id, corrected_at)
        values (${correctionId}, ${id}, 500, ${envelope("commission_ruling_corrections", correctionId, "reason")}::jsonb,
          'reduced', ${p.creator.userId}, 'synthetic-session', ${randomUUID()}, ${randomUUID()}, ${correctedAt})`;
    };
    await correction("2026-11-06T04:00:00Z");
    await refused(correction("2026-11-06T04:00:00.001Z"));
  });
  test("the correction guard refuses an open pause, accepts its extension inclusively and rejects outside it", async () => {
    const p = await fixture.paidOrder(); const id = await ruling(await dispute(p.orderId, p.buyer.userId), p.creator.userId, p.s.policyId);
    const correction = (correctedAt: string) => {
      const correctionId = randomUUID();
      return fixture.client`insert into commission_ruling_corrections (id, ruling_id, refund_amount_vnd, reason_envelope,
        effect, owner_user_id, actor_session_id, step_up_proof_id, request_id, corrected_at)
        values (${correctionId}, ${id}, 500, ${envelope("commission_ruling_corrections", correctionId, "reason")}::jsonb,
          'reduced', ${p.creator.userId}, 'synthetic-session', ${randomUUID()}, ${randomUUID()}, ${correctedAt})`;
    };
    const pauseId = randomUUID();
    await fixture.client`insert into commission_resolution_pauses (id, started_at) values (${pauseId}, '2026-11-06T03:59:59.999Z')`;
    try { await refused(correction("2026-11-06T04:00:00Z")); }
    finally { await fixture.client`update commission_resolution_pauses set ended_at = '2026-11-07T04:00:00Z', version = 2 where id = ${pauseId}`; }
    await refused(correction("2026-10-07T03:59:59.999Z"));
    await correction("2026-11-08T04:00:00Z");
    await correction("2026-11-09T04:00:00Z");
    await refused(correction("2026-11-09T04:00:00.001Z"));
  });
  test("rulings and statements cannot be updated or deleted", async () => {
    const p = await fixture.paidOrder(); const d = await dispute(p.orderId, p.buyer.userId);
    const s = await statement(d, p.buyer.userId); const r = await ruling(d, p.creator.userId, p.s.policyId);
    await refused(fixture.client`update commission_dispute_statements set request_id = ${randomUUID()} where id = ${s}`);
    await refused(fixture.client`delete from commission_dispute_statements where id = ${s}`);
    await refused(fixture.client`update commission_rulings set refund_amount_vnd = 500 where id = ${r}`);
    await refused(fixture.client`delete from commission_rulings where id = ${r}`);
  });
  test("proposal identity and version cannot be rewritten", async () => {
    const p = await fixture.paidOrder(); const id = await proposal(p.orderId, p.buyer.userId);
    await refused(fixture.client`update commission_proposals set proposer_user_id = ${p.creator.userId}, version = version + 1 where id = ${id}`);
    await refused(fixture.client`update commission_proposals set version = version + 2 where id = ${id}`);
  });
});
