import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createCommissionResolutionTestFixture } from "../../../apps/web/tests/commission-resolution-test-support.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for trust case schema tests");
const parsed = new URL(databaseUrl);
if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || !/test|ci/iu.test(parsed.pathname)) {
  throw new Error("Trust case schema tests require a dedicated local test database");
}
const fixture = createCommissionResolutionTestFixture("trust_cases_schema");
beforeAll(fixture.initialize, 30_000); afterAll(fixture.dispose, 30_000);
const at = new Date("2026-10-07T04:00:00Z");
const later = new Date(at.getTime() + 1_000);

async function expectSqlState(operation: PromiseLike<unknown>, code = "23514") {
  try { await operation; } catch (error) { expect(error).toMatchObject({ code }); return; }
  throw new Error(`Expected SQLSTATE ${code}`);
}
async function event(tx: TransactionSql, caseId: string, version: number, action = "opened", resolutionKind: string | null = null) {
  await tx`insert into trust_case_events (id, case_id, action, request_id, expected_version, resulting_version, before_state, after_state, resolution_kind, occurred_at)
    values (${randomUUID()}, ${caseId}, ${action}, ${randomUUID()}, ${version - 1}, ${version}, ${version === 1 ? null : "open"},
      ${action === "resolved" ? "resolved" : "open"}, ${resolutionKind}, ${version === 1 ? at.toISOString() : later.toISOString()})`;
}
async function insertCase(tx: TransactionSql, orderId: string, options: { id?: string; sourceId?: string; kind?: string; sourceType?: string } = {}) {
  const id = options.id ?? randomUUID(); const sourceId = options.sourceId ?? randomUUID();
  await tx`insert into trust_cases (id, kind, order_id, source_type, source_id, opened_at)
    values (${id}, ${options.kind ?? "dispute"}, ${orderId}, ${options.sourceType ?? "commission_dispute"}, ${sourceId}, ${at.toISOString()})`;
  await event(tx, id, 1);
  return { id, sourceId };
}
async function open() {
  const p = await fixture.paidOrder();
  const c = await fixture.client.begin((tx) => insertCase(tx, p.orderId));
  return { ...c, p };
}
async function resolve(caseId: string) {
  await fixture.client.begin(async (tx) => {
    await tx`update trust_cases set state = 'resolved', resolution_kind = 'ruled', resolved_at = ${later.toISOString()}, version = 2 where id = ${caseId}`;
    await event(tx, caseId, 2, "resolved", "ruled");
  });
}

describe("trust case database boundaries", () => {
  test("a case kind must match its source type", async () => {
    const p = await fixture.paidOrder();
    await expectSqlState(fixture.client.begin((tx) => insertCase(tx, p.orderId, { kind: "dispute", sourceType: "commission_refund_obligation" })));
    await expectSqlState(fixture.client.begin((tx) => insertCase(tx, p.orderId, { kind: "late_payment", sourceType: "commission_dispute" })));
  });
  test("resolved is terminal", async () => {
    const c = await open(); await resolve(c.id);
    await expectSqlState(fixture.client`update trust_cases set state = 'open', resolution_kind = null, resolved_at = null, version = 3 where id = ${c.id}`);
    await expectSqlState(fixture.client`update trust_cases set version = 3 where id = ${c.id}`);
  });
  test("access log rows cannot be updated or deleted", async () => {
    const c = await open(); const id = randomUUID();
    await fixture.client`insert into trust_case_access_log (id, case_id, item_type, item_id, owner_user_id, owner_session_id, request_id, accessed_at)
      values (${id}, ${c.id}, 'order_summary', ${c.p.orderId}, ${c.p.creator.userId}, ${c.p.creator.sessionId}, ${randomUUID()}, ${at.toISOString()})`;
    await expectSqlState(fixture.client`update trust_case_access_log set request_id = ${randomUUID()} where id = ${id}`);
    await expectSqlState(fixture.client`delete from trust_case_access_log where id = ${id}`);
  });
  test("two open cases for one source fail; a new one after resolution succeeds", async () => {
    const c = await open();
    await expectSqlState(fixture.client.begin((tx) => insertCase(tx, c.p.orderId, { sourceId: c.sourceId })), "23505");
    await resolve(c.id);
    const reopened = await fixture.client.begin((tx) => insertCase(tx, c.p.orderId, { sourceId: c.sourceId }));
    expect(reopened.id).not.toBe(c.id);
  });
  test("version bumps require a matching append-only event", async () => {
    const c = await open();
    await expectSqlState(fixture.client`update trust_cases set version = 2 where id = ${c.id}`);
    await fixture.client.begin(async (tx) => {
      await tx`update trust_cases set version = 2 where id = ${c.id}`;
      await event(tx, c.id, 2, "question_posted");
    });
    await expectSqlState(fixture.client`update trust_case_events set request_id = ${randomUUID()} where case_id = ${c.id}`);
    await expectSqlState(fixture.client`delete from trust_case_events where case_id = ${c.id}`);
  });
  test("case identity and resolution kinds are guarded", async () => {
    const c = await open();
    await expectSqlState(fixture.client`update trust_cases set source_id = ${randomUUID()}, version = 2 where id = ${c.id}`);
    await expectSqlState(fixture.client`update trust_cases set state = 'resolved', resolution_kind = 'receipt_accepted', resolved_at = ${later.toISOString()}, version = 2 where id = ${c.id}`);
    await expectSqlState(fixture.client`delete from trust_cases where id = ${c.id}`);
  });
});
