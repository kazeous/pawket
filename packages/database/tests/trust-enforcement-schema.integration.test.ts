import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as schema from "../src/schema.js";
import { effectiveEnforcementDeadline, recordEnforcementModeTransition } from "../../trust/src/enforcement-deadlines.js";
import { insertTestPenalty, penaltyAt, seedPenaltySubject } from "./trust-penalty-fixture.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for trust enforcement schema tests");
const parsed = new URL(databaseUrl);
if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || !/test|ci/iu.test(parsed.pathname)) {
  throw new Error("Trust enforcement schema tests require a dedicated local test database");
}
const schemaName = `trust_enforcement_${process.pid}_${Date.now()}`; const journalSchema = `${schemaName}_journal`;
const client = postgres(databaseUrl, { max: 4, connection: { search_path: `${schemaName},public` }, onnotice: () => undefined });
const db = drizzle(client, { schema });
beforeAll(async () => {
  await client.unsafe(`create schema "${schemaName}"`);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations/", import.meta.url)), migrationsSchema: journalSchema });
}, 30_000);
afterAll(async () => {
  await client.unsafe(`drop schema if exists "${schemaName}" cascade`);
  await client.unsafe(`drop schema if exists "${journalSchema}" cascade`);
  await client.end();
}, 30_000);
async function refused(operation: PromiseLike<unknown>, code = "23514") {
  try { await operation; } catch (error) { expect(error).toMatchObject({ code }); return; }
  throw new Error(`Expected SQLSTATE ${code}`);
}
async function revision(kind: string, number: number, document = "Synthetic policy") {
  const id = randomUUID(); const checksum = `sha256:${createHash("sha256").update(document).digest("hex")}`;
  await client`insert into trust_policy_revisions (id, kind, revision_number, document, approval_kind, checksum, source, effective_at, created_at)
    values (${id}, ${kind}, ${number}, ${document}, 'synthetic', ${checksum}, 'synthetic-test', '2026-10-10T00:00Z', '2026-10-10T00:00Z')`;
  return id;
}

describe("trust enforcement database boundaries", () => {
  test("a second active suspension of the same target is rejected", async () => {
    const subject = await seedPenaltySubject(client);
    const first = await insertTestPenalty(client, subject);
    await refused(insertTestPenalty(client, subject), "23505");
    await client`update trust_penalties set state = 'expired', ended_at = '2026-10-11T00:00Z', version = version + 1 where id = ${first}`;
    await insertTestPenalty(client, subject);
  });
  test("warning cannot carry ends_at and each kind has its own shape", async () => {
    const subject = await seedPenaltySubject(client);
    await refused(insertTestPenalty(client, subject, { kind: "warning", endsAt: new Date("2026-10-11T00:00Z") }));
    await refused(insertTestPenalty(client, subject, { kind: "warning", restriction: "reporting" }));
    await refused(insertTestPenalty(client, subject, { kind: "restriction", target: "account" }));
    await refused(insertTestPenalty(client, subject, { kind: "suspension", restriction: "reporting" }));
    await refused(insertTestPenalty(client, subject, { kind: "removal", endsAt: new Date("2026-10-11T00:00Z") }));
    await refused(insertTestPenalty(client, subject, { endsAt: penaltyAt }));
  });
  test("ending a penalty twice is rejected and identity columns are immutable", async () => {
    const subject = await seedPenaltySubject(client); const id = await insertTestPenalty(client, subject);
    await refused(client`update trust_penalties set reason_category = 'privacy', version = version + 1 where id = ${id}`);
    await refused(client`delete from trust_penalties where id = ${id}`);
    await client`update trust_penalties set state = 'lifted', ended_at = '2026-10-10T01:00Z', end_reason = 'owner_lifted', version = version + 1 where id = ${id}`;
    await refused(client`update trust_penalties set state = 'reversed', ended_at = '2026-10-10T02:00Z', version = version + 1 where id = ${id}`);
    await refused(client`update trust_penalties set state = 'active', ended_at = null, version = version + 1 where id = ${id}`);
  });
  test("a warning can be acknowledged only once", async () => {
    const subject = await seedPenaltySubject(client); const id = await insertTestPenalty(client, subject, { kind: "warning" });
    await client`update trust_penalties set acknowledged_at = '2026-10-10T01:00Z', version = version + 1 where id = ${id}`;
    await refused(client`update trust_penalties set acknowledged_at = '2026-10-10T02:00Z', version = version + 1 where id = ${id}`);
    const suspension = await insertTestPenalty(client, subject);
    await refused(client`update trust_penalties set acknowledged_at = '2026-10-10T01:00Z', version = version + 1 where id = ${suspension}`);
  });
  test("penalty events are append-only", async () => {
    const subject = await seedPenaltySubject(client); const penaltyId = await insertTestPenalty(client, subject); const id = randomUUID();
    await client`insert into trust_penalty_events (id, penalty_id, action, actor_user_id, actor_session_id, request_id, expected_version, resulting_version, occurred_at)
      values (${id}, ${penaltyId}, 'applied', ${subject.ownerUserId}, 'owner-session', 'test', 0, 1, ${penaltyAt.toISOString()})`;
    await refused(client`update trust_penalty_events set action = 'expired' where id = ${id}`);
    await refused(client`delete from trust_penalty_events where id = ${id}`);
  });
  test("capability may become removed and back to active", async () => {
    const subject = await seedPenaltySubject(client);
    await client`update identity_creator_capabilities set state = 'removed', suspended_at = ${penaltyAt.toISOString()}, version = version + 1 where id = ${subject.capabilityId}`;
    await client`update identity_creator_capabilities set state = 'active', suspended_at = null, version = version + 1 where id = ${subject.capabilityId}`;
    await refused(client`update identity_creator_capabilities set state = 'removed', suspended_at = null where id = ${subject.capabilityId}`);
  });
  test("actorless capability event only for penalty_expired", async () => {
    const subject = await seedPenaltySubject(client); const penaltyId = await insertTestPenalty(client, subject);
    async function event(action: string, reason: string, actorUserId: string | null = null, actorSessionId: string | null = null, proofId: string | null = null) {
      return client`insert into identity_creator_capability_events (id, capability_id, action, state, version, actor_user_id, actor_session_id, step_up_proof_id, reason_code, penalty_id, request_id, created_at)
        values (${randomUUID()}, ${subject.capabilityId}, ${action}, 'active', 2, ${actorUserId}, ${actorSessionId}, ${proofId}, ${reason}, ${penaltyId}, 'test', ${penaltyAt.toISOString()})`;
    }
    await event("reinstated", "penalty_expired"); await event("restored", "penalty_expired");
    await refused(event("suspended", "penalty_expired")); await refused(event("removed", "penalty_expired"));
    await refused(event("reinstated", "other")); await refused(event("restored", "penalty_expired", subject.ownerUserId));
    await event("removed", "other", subject.ownerUserId, "owner-session", subject.actor.stepUpProofId);
  });
  test("effective deadline moves to resume plus 48 hours", async () => {
    await recordEnforcementModeTransition(db, { mode: "disabled", at: new Date("2026-11-01T00:00Z") });
    await recordEnforcementModeTransition(db, { mode: "enabled", at: new Date("2026-11-03T00:00Z") });
    for (const [deadline, expected] of [["2026-10-31T00:00Z", "2026-10-31T00:00Z"],
      ["2026-11-01T00:00Z", "2026-11-05T00:00Z"], ["2026-11-02T00:00Z", "2026-11-05T00:00Z"],
      ["2026-11-03T00:00Z", "2026-11-03T00:00Z"]]) {
      expect(await effectiveEnforcementDeadline(db, new Date(deadline!))).toEqual(new Date(expected!));
    }
    await recordEnforcementModeTransition(db, { mode: "disabled", at: new Date("2026-11-05T00:00Z") });
    await recordEnforcementModeTransition(db, { mode: "enabled", at: new Date("2026-11-06T00:00Z") });
    expect(await db.transaction((tx) => effectiveEnforcementDeadline(tx, new Date("2026-11-02T00:00Z")))).toEqual(new Date("2026-11-08T00:00Z"));
  });
  test("effective deadline is null while a pause is open", async () => {
    await recordEnforcementModeTransition(db, { mode: "disabled", at: new Date("2027-01-01T00:00Z") });
    try {
      expect(await effectiveEnforcementDeadline(db, new Date("2027-01-01T00:00Z"))).toBeNull();
      expect(await effectiveEnforcementDeadline(db, new Date("2027-01-02T00:00Z"))).toBeNull();
      expect(await effectiveEnforcementDeadline(db, new Date("2026-12-31T00:00Z"))).toEqual(new Date("2026-12-31T00:00Z"));
      await refused(client`insert into trust_enforcement_pauses (id, started_at) values (${randomUUID()}, '2027-01-02T00:00Z')`, "23505");
    } finally { await recordEnforcementModeTransition(db, { mode: "enabled", at: new Date("2027-01-03T00:00Z") }); }
  });
  test("mode transitions are idempotent under concurrency", async () => {
    await Promise.all(Array.from({ length: 4 }, () => recordEnforcementModeTransition(db, { mode: "disabled", at: new Date("2028-01-01T00:00Z") })));
    const [opened] = await client`select * from trust_enforcement_pauses where ended_at is null`;
    expect(opened!.version).toBe(1);
    await expect(recordEnforcementModeTransition(db, { mode: "enabled", at: new Date("2027-12-31T00:00Z") })).rejects.toMatchObject({ code: "invalid_request" });
    await Promise.all(Array.from({ length: 4 }, () => recordEnforcementModeTransition(db, { mode: "enabled", at: new Date("2028-01-02T00:00Z") })));
    const rows = await client`select * from trust_enforcement_pauses where started_at = '2028-01-01T00:00Z'`;
    expect(rows).toHaveLength(1); expect(rows[0]!.version).toBe(2);
  });
  test("policy revisions are immutable and current pointer must advance", async () => {
    const first = await revision("community_rules", 1); const second = await revision("community_rules", 2);
    await client`insert into trust_policy_current (kind, revision_id, updated_at) values ('community_rules', ${first}, now())`;
    await refused(client`update trust_policy_revisions set document = 'Changed policy' where id = ${first}`);
    await refused(client`delete from trust_policy_revisions where id = ${second}`);
    await client`update trust_policy_current set revision_id = ${second}, updated_at = now() where kind = 'community_rules'`;
    await refused(client`update trust_policy_current set revision_id = ${first} where kind = 'community_rules'`);
    await refused(client`update trust_policy_current set revision_id = ${second} where kind = 'community_rules'`);
    const wrongKind = await revision("enforcement_appeals", 1);
    await refused(client`update trust_policy_current set revision_id = ${wrongKind} where kind = 'community_rules'`);
    await refused(client`insert into trust_policy_current (kind, revision_id, updated_at) values ('enforcement_appeals', ${second}, now())`);
    await refused(client`delete from trust_policy_current where kind = 'community_rules'`);
  });
  test("policy rows enforce kind, revision, NFC, code point bounds, control characters and approval evidence", async () => {
    for (const [kind, number, document] of [["unknown", 1, "policy"], ["community_rules", 0, "policy"],
      ["community_rules", 3, ""], ["community_rules", 3, "e\u0301"], ["community_rules", 3, "a\tb"],
      ["community_rules", 3, "𝒜".repeat(16_001)]] as const) await refused(revision(kind, number, document));
    const id = await revision("community_rules", 3, "𝒜".repeat(16_000));
    expect(id).toBeTypeOf("string"); await revision("community_rules", 4, "a\nb");
    await refused(client`insert into trust_policy_revisions (id, kind, revision_number, document, approval_kind, checksum, source, effective_at, created_at)
      values (${randomUUID()}, 'community_rules', 5, 'policy', 'owner_reviewed', ${"sha256:" + "a".repeat(64)}, 'test', now(), now())`);
    await refused(client`insert into trust_policy_revisions (id, kind, revision_number, document, approval_kind, actor_session_id, checksum, source, effective_at, created_at)
      values (${randomUUID()}, 'community_rules', 5, 'policy', 'synthetic', 'session', ${"sha256:" + "a".repeat(64)}, 'test', now(), now())`);
  });
});
