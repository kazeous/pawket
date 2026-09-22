import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { adminAuditEvents, createDatabase, identityUsers, platformTipPolicyCurrent, platformTipPolicyRevisions,
  systemCommandIdempotency, PLATFORM_TIP_POLICY_BOOTSTRAP_ID, type PawketTransaction } from "@pawket/database";
import { createPlatformTipPolicyReadPort, createPlatformTipPolicyService, type PlatformTipPolicySaveCommand } from "../src/platform-tip-policy.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for platform policy integration tests");
const schemaName = `policy_domain_${process.pid}_${Date.now()}`;
const journalSchema = `${schemaName}_journal`;
const admin = createDatabase(databaseUrl);
const url = new URL(databaseUrl); url.searchParams.set("options", `-csearch_path=${schemaName},public`); url.searchParams.set("application_name", schemaName);
const database = createDatabase(url.toString()); const db = database.db;
const actor = { userId: `policy-owner-${randomUUID()}`, sessionId: "owner-session" };
let allowed = true; let proofAllowed = true; let proofCalls = 0;
const now = new Date("2027-01-01T00:00:00.000Z");
const serviceInput = { db, applicationRevision: "test-policy-revision", commandFingerprintKey: new Uint8Array(32).fill(31),
  now: () => now,
  async authorizeOwner(_tx: PawketTransaction, candidate: typeof actor) { return allowed && candidate.userId === actor.userId && candidate.sessionId === actor.sessionId; },
  async requireOwnerStepUp(tx: PawketTransaction) { proofCalls++; await tx.execute(sql`update policy_test_proof set spent = spent + 1`); return proofAllowed; },
};
const service = createPlatformTipPolicyService(serviceInput);
const readPort = createPlatformTipPolicyReadPort();
const current = () => db.transaction((tx) => readPort.readPolicy(tx));
async function command(patch: Partial<PlatformTipPolicySaveCommand> = {}): Promise<PlatformTipPolicySaveCommand> {
  return { actor, expectedRevision: (await current())!.revisionNumber, minimumVnd: 10_000, maximumVnd: 5_000_000,
    allowedPresetsVnd: [20_000, 50_000, 100_000], reason: "Synthetic policy edit", idempotencyKey: randomUUID(), requestId: randomUUID(), ...patch };
}
async function state() {
  return { revisions: await db.select().from(platformTipPolicyRevisions), pointer: await db.select().from(platformTipPolicyCurrent),
    audit: await db.select().from(adminAuditEvents), commands: await db.select().from(systemCommandIdempotency),
    proof: Array.from(await db.execute(sql`select spent from policy_test_proof`)) };
}
function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { release, promise }; }
async function waitForBlocked() {
  await vi.waitFor(async () => {
    const rows = await admin.db.execute(sql`select count(*)::int as count from pg_stat_activity where application_name = ${schemaName} and wait_event_type = 'Lock'`);
    expect(Number(rows[0]?.count)).toBeGreaterThan(0);
  }, { timeout: 5_000, interval: 20 });
}

beforeAll(async () => {
  await admin.db.execute(sql.raw(`create schema "${schemaName}"`));
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../database/migrations/", import.meta.url)), migrationsSchema: journalSchema });
  await db.insert(identityUsers).values({ id: actor.userId, name: "Synthetic owner", email: `${actor.userId}@example.invalid`, canonicalEmail: `${actor.userId}@example.invalid` });
  await db.execute(sql`create table policy_test_proof (spent integer not null)`);
  await db.execute(sql`insert into policy_test_proof values (0)`);
});
afterAll(async () => {
  await database.close();
  await admin.db.execute(sql.raw(`drop schema if exists "${schemaName}" cascade`));
  await admin.db.execute(sql.raw(`drop schema if exists "${journalSchema}" cascade`));
  await admin.close();
});

test("migration bootstraps honest system evidence exactly once and reader projection is private-field free", async () => {
  const first = await current();
  expect(first).toMatchObject({ revisionId: PLATFORM_TIP_POLICY_BOOTSTRAP_ID, revisionNumber: 1, minimumVnd: 10_000, maximumVnd: 5_000_000, allowedPresetsVnd: [20_000, 50_000, 100_000] });
  const history = await service.getHistory({ actor });
  expect(history.revisions).toEqual([{ ...first, origin: "system_bootstrap", actorUserId: null, reason: "Bootstrap approved launch policy", previousPolicy: null }]);
  expect(Object.keys(first!).sort()).toEqual(["allowedPresetsVnd", "effectiveAt", "maximumVnd", "minimumVnd", "revisionId", "revisionNumber"].sort());
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../database/migrations/", import.meta.url)), migrationsSchema: journalSchema });
  expect(await current()).toEqual(first);
});

test("a skewed first owner save preserves bootstrap microseconds and exact pointer time", async () => {
  const [before] = await db.execute(sql`select effective_at::text as timestamp from platform_tip_policy_revisions where revision_number = 1`);
  const skewed = createPlatformTipPolicyService({ ...serviceInput, now: () => new Date("2020-01-01T00:00:00.000Z") });
  const result = await skewed.savePolicy(await command());
  const [stored] = await db.execute(sql`select revision.effective_at::text as timestamp,
    revision.effective_at = pointer.updated_at as pointer_matches
    from platform_tip_policy_revisions revision join platform_tip_policy_current pointer on pointer.revision_id = revision.id`);
  expect(stored?.timestamp).toBe(before?.timestamp);
  expect(stored?.pointer_matches).toBe(true);
  expect(result.revisionNumber).toBe(2);
});

test("save commits revision, pointer, private history, audit, proof and command together", async () => {
  const before = await current();
  const input = await command({ minimumVnd: 30_000, allowedPresetsVnd: [100_000, 50_000, 30_000, 200_000] });
  const result = await service.savePolicy(input);
  expect(result).toMatchObject({ minimumVnd: 30_000, allowedPresetsVnd: [100_000, 50_000, 30_000, 200_000], revisionNumber: before!.revisionNumber + 1 });
  expect(await current()).toEqual(result);
  const [audit] = await db.select().from(adminAuditEvents).where(eq(adminAuditEvents.subjectId, result.revisionId));
  expect(audit).toMatchObject({ actorUserId: actor.userId, actorSessionId: actor.sessionId, beforeState: before, afterState: result, assurance: { method: "owner_step_up" } });
  const history = await service.getHistory({ actor, limit: 1 });
  expect(history.revisions[0]).toMatchObject({ ...result, origin: "owner", actorUserId: actor.userId, reason: input.reason, previousPolicy: before });
  expect(history.nextBeforeRevision).toBe(result.revisionNumber);
  expect((await service.getHistory({ actor, beforeRevision: history.nextBeforeRevision!, limit: 1 })).revisions[0]?.revisionNumber).toBe(before!.revisionNumber);
});

test("replay returns original revision after newer policy without consuming proof, but reauthorizes actor/body", async () => {
  const input = await command(); const result = await service.savePolicy(input);
  await service.savePolicy(await command({ minimumVnd: 40_000, allowedPresetsVnd: [40_000, 50_000, 100_000] }));
  const before = await state(); const calls = proofCalls;
  expect(await service.savePolicy({ ...input, requestId: randomUUID() })).toEqual(result);
  expect(proofCalls).toBe(calls); expect(await state()).toEqual(before);
  await expect(service.savePolicy({ ...input, reason: "Different body" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  allowed = false;
  try { await expect(service.savePolicy(input)).rejects.toMatchObject({ code: "FORBIDDEN" }); }
  finally { allowed = true; }
  expect(await state()).toEqual(before);
});

test("owner denial, stale revision and missing step-up roll back commands and proof consumption", async () => {
  const input = await command(); const before = await state();
  allowed = false;
  try {
    await expect(service.savePolicy(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.getPolicy({ actor })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.getHistory({ actor })).rejects.toMatchObject({ code: "FORBIDDEN" });
  } finally { allowed = true; }
  const calls = proofCalls;
  await expect(service.savePolicy({ ...input, expectedRevision: 1 })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(proofCalls).toBe(calls);
  proofAllowed = false;
  try { await expect(service.savePolicy(input)).rejects.toMatchObject({ code: "OWNER_STEP_UP_REQUIRED" }); }
  finally { proofAllowed = true; }
  expect(await state()).toEqual(before);
});

test("audit insertion failure rolls back revision, pointer, command and transaction-bound proof", async () => {
  const before = await state();
  await db.execute(sql`create function policy_test_fail_audit() returns trigger language plpgsql as $$ begin raise exception 'synthetic audit failure'; end; $$`);
  await db.execute(sql`create trigger policy_test_fail_audit before insert on admin_audit_events for each row execute function policy_test_fail_audit()`);
  try { await expect(service.savePolicy(await command())).rejects.toThrow(); }
  finally { await db.execute(sql`drop trigger policy_test_fail_audit on admin_audit_events`); }
  expect(await state()).toEqual(before);
});

test("concurrent owner commands with one expected revision produce one commit and one conflict", async () => {
  const input = await command(); const calls = proofCalls;
  const outcomes = await Promise.allSettled([service.savePolicy(input), service.savePolicy({ ...input, idempotencyKey: randomUUID(), requestId: randomUUID(), reason: "Competing owner edit" })]);
  expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "VERSION_CONFLICT" } });
  expect(proofCalls).toBe(calls + 1);
  expect((await current())?.revisionNumber).toBe(input.expectedRevision + 1);
});

test("same-key concurrent retries commit one audited revision and consume one proof", async () => {
  const input = await command(); const calls = proofCalls;
  const [first, second] = await Promise.all([service.savePolicy(input), service.savePolicy(input)]);
  expect(first).toEqual(second); expect(proofCalls).toBe(calls + 1);
  expect(await db.select().from(adminAuditEvents).where(eq(adminAuditEvents.subjectId, first.revisionId))).toHaveLength(1);
});

test("shared policy reader fences owner commit; independent service sees committed revision immediately", async () => {
  const entered = gate(); const finish = gate(); const input = await command();
  const reader = db.transaction(async (tx) => { const result = await readPort.readPolicy(tx); entered.release(); await finish.promise; return result; });
  await entered.promise;
  const writer = service.savePolicy(input);
  try { await waitForBlocked(); } finally { finish.release(); }
  const [old, updated] = await Promise.all([reader, writer]);
  expect(old!.revisionNumber + 1).toBe(updated.revisionNumber);
  const independent = createDatabase(url.toString());
  try {
    const independentService = createPlatformTipPolicyService({ ...serviceInput, db: independent.db });
    expect(await independentService.getPolicy({ actor })).toEqual(updated);
  } finally { await independent.close(); }
});

test("owner exclusive fence keeps readers from observing revision before audit commit", async () => {
  const entered = gate(); const finish = gate(); const input = await command();
  const writerService = createPlatformTipPolicyService({ ...serviceInput, async requireOwnerStepUp(tx) {
    entered.release(); await finish.promise; return serviceInput.requireOwnerStepUp(tx);
  } });
  const writer = writerService.savePolicy(input); await entered.promise;
  const reader = current();
  try { await waitForBlocked(); } finally { finish.release(); }
  const [updated, observed] = await Promise.all([writer, reader]);
  expect(observed).toEqual(updated);
});

test("restoring earlier values appends revision and backwards wall clocks preserve effective time", async () => {
  const before = (await current())!;
  const skewed = createPlatformTipPolicyService({ ...serviceInput, now: () => new Date("2026-01-01T00:00:00.000Z") });
  const result = await skewed.savePolicy(await command());
  expect(result.revisionNumber).toBe(before.revisionNumber + 1);
  expect(result.effectiveAt).toBe(before.effectiveAt);
  expect(result.revisionId).not.toBe(before.revisionId);
});

async function sqlState(promise: PromiseLike<unknown>, code: string) {
  try { await promise; } catch (error) {
    expect((error as { cause?: unknown }).cause ?? error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected SQLSTATE ${code}`);
}

async function directRevision(patch: Partial<typeof platformTipPolicyRevisions.$inferInsert> = {}) {
  const before = (await current())!;
  return { id: randomUUID(), revisionNumber: before.revisionNumber + 1, previousRevisionId: before.revisionId,
    minimumVnd: 10_000, maximumVnd: 5_000_000, allowedPresetsVnd: [20_000, 50_000, 100_000],
    origin: "owner" as const, actorUserId: actor.userId, actorSessionId: actor.sessionId,
    requestId: randomUUID(), reason: "Synthetic direct SQL policy", effectiveAt: new Date("2030-01-01T00:00:00.000Z"), ...patch };
}

test("database rejects invalid bounds, presets, origin and missing actor evidence", async () => {
  const before = await state();
  for (const patch of [
    { minimumVnd: 9_999 }, { maximumVnd: 5_000_001 }, { minimumVnd: 100_001, maximumVnd: 100_000 },
    { allowedPresetsVnd: [20_000, 50_000] }, { allowedPresetsVnd: [20_000, 20_000, 100_000] },
    { allowedPresetsVnd: [20_000, 50_000, 5_000_001] }, { allowedPresetsVnd: Array.from({ length: 11 }, (_, i) => 20_000 + i) },
    { actorUserId: null }, { actorSessionId: null }, { requestId: null }, { actorSessionId: "bad session" },
    { reason: "  padded reason" }, { reason: "a\nreason" }, { reason: "a".repeat(501) },
    { origin: "system_bootstrap" as const }, { previousRevisionId: PLATFORM_TIP_POLICY_BOOTSTRAP_ID },
    { effectiveAt: new Date("2020-01-01T00:00:00.000Z") },
  ]) await sqlState(db.insert(platformTipPolicyRevisions).values(await directRevision(patch)), "23514");
  await sqlState(db.insert(platformTipPolicyRevisions).values(await directRevision({ actorUserId: "nonexistent-owner" })), "23503");
  for (const allowedPresetsVnd of [sql`array[20000,null,100000]::integer[]`,
    sql`array[[20000,50000,100000],[30000,60000,200000]]::integer[]`, sql`'[0:2]={20000,50000,100000}'::integer[]`]) {
    await sqlState(db.insert(platformTipPolicyRevisions).values({ ...await directRevision(), allowedPresetsVnd }), "23514");
  }
  expect(await state()).toEqual(before);
});

test("policy accepts the full ordered ten-preset envelope without sorting or dropping choices", async () => {
  const allowedPresetsVnd = [5_000_000, 10_000, 20_000, 30_000, 40_000, 50_000, 60_000, 70_000, 80_000, 90_000];
  const result = await service.savePolicy(await command({ allowedPresetsVnd }));
  expect(result.allowedPresetsVnd).toEqual(allowedPresetsVnd);
  expect((await current())!.allowedPresetsVnd).toEqual(allowedPresetsVnd);
});

test("a direct SQL revision cannot commit without its matching pointer advance", async () => {
  const before = await state();
  await sqlState(db.insert(platformTipPolicyRevisions).values(await directRevision()), "23514");
  expect(await state()).toEqual(before);
  // Rejection does not occupy the next revision number or break normal saves.
  expect((await service.savePolicy(await command())).revisionNumber).toBe(before.revisions.length + 1);
});

test("policy evidence is append-only and pointer cannot be deleted, rewound or recreated", async () => {
  const before = await state();
  const active = (await current())!;
  await sqlState(db.update(platformTipPolicyRevisions).set({ reason: "Rewrite history" }).where(eq(platformTipPolicyRevisions.id, active.revisionId)), "55000");
  await sqlState(db.delete(platformTipPolicyRevisions).where(eq(platformTipPolicyRevisions.id, active.revisionId)), "55000");
  await sqlState(db.delete(platformTipPolicyCurrent), "55000");
  await sqlState(db.insert(platformTipPolicyCurrent).values({ singleton: true, revisionId: active.revisionId, updatedAt: now }), "55000");
  await sqlState(db.update(platformTipPolicyCurrent).set({ revisionId: PLATFORM_TIP_POLICY_BOOTSTRAP_ID }), "23514");
  await sqlState(db.update(platformTipPolicyCurrent).set({ revisionId: active.revisionId }), "23514");
  expect(await state()).toEqual(before);
});

test("missing policy fails closed for reads and owner mutation without spending proof", async () => {
  const before = await state(); const calls = proofCalls; const input = await command();
  const rollback = new Error("rollback missing policy fixture");
  await expect(db.transaction(async (tx) => {
    // Deliberate corruption is transaction-local and always rolled back.
    await tx.execute(sql`alter table platform_tip_policy_current disable trigger platform_tip_policy_pointer_guard`);
    await tx.delete(platformTipPolicyCurrent);
    expect(await readPort.readPolicy(tx)).toBeNull();
    const missing = createPlatformTipPolicyService({ ...serviceInput, db: tx as unknown as typeof db });
    await expect(missing.getPolicy({ actor })).resolves.toBeNull();
    await expect(missing.savePolicy(input)).rejects.toMatchObject({ code: "POLICY_UNAVAILABLE" });
    expect(proofCalls).toBe(calls);
    throw rollback;
  })).rejects.toBe(rollback);
  expect(await state()).toEqual(before);
});
