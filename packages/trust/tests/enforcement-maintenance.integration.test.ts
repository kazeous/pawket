import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import * as schema from "@pawket/database";
import { createPenaltyService } from "../src/penalty-service.js";
import { createEnforcementMaintenance } from "../src/enforcement-maintenance.js";
import { createReportFixture, fixtureLookupKey, reportAt } from "./report-fixture.js";
import { penaltyContext } from "./penalty-service-fixture.js";
import { createLookupHmac } from "@pawket/security";
import { recordCreatorCapabilityChange } from "@pawket/identity";

const f = createReportFixture("enforcement_maintenance"); beforeAll(f.initialize, 60_000); afterAll(f.dispose, 30_000);
const at = new Date(reportAt.getTime() + 1_000);
async function expiring(shape: { kind: "restriction"; restriction: "reporting" } | { kind: "suspension"; target: "creator_capability" | "account" } = { kind: "restriction", restriction: "reporting" }) {
  const c = await penaltyContext(f);
  const { penaltyId } = await c.service.apply({ ...await c.command(), ...shape, endsAt: at.toISOString() });
  const penalties = createPenaltyService({ ...c.input, now: () => at });
  return { ...c, penaltyId, penalties };
}

test("expired restriction ends and the actorless event is recorded", async () => {
  const c = await expiring(); const maintenance = createEnforcementMaintenance({ db: f.db, penalties: c.penalties, mode: "enabled", now: () => at });
  expect(await maintenance.runOnce()).toMatchObject({ expired: 1 });
  expect((await f.db.select().from(schema.trustPenalties).where(eq(schema.trustPenalties.id, c.penaltyId)))[0]).toMatchObject({ state: "expired", endedAt: at, endReason: "expired", version: 2 });
  expect(await f.db.select().from(schema.trustPenaltyEvents).where(and(eq(schema.trustPenaltyEvents.penaltyId, c.penaltyId), eq(schema.trustPenaltyEvents.action, "expired")))).toMatchObject([
    { actorUserId: null, actorSessionId: null, reasonEnvelope: null, expectedVersion: 1, resultingVersion: 2 }]);
  expect(await f.db.select().from(schema.systemOutbox).where(and(eq(schema.systemOutbox.aggregateId, c.penaltyId), eq(schema.systemOutbox.eventType, "trust.penalty_ended.v1")))).toMatchObject([
    { payload: { penaltyId: c.penaltyId, subjectUserId: c.p.creator.userId, state: "expired" } }]);
  expect(c.consume).toHaveBeenCalledOnce();
});

test("creator suspension expiry restores active capability with the penalty_expired reason", async () => {
  const c = await expiring({ kind: "suspension", target: "creator_capability" });
  await createEnforcementMaintenance({ db: f.db, penalties: c.penalties, mode: "enabled", now: () => at }).runOnce();
  expect((await f.db.select().from(schema.identityCreatorCapabilities).where(eq(schema.identityCreatorCapabilities.id, c.capabilityId)))[0]).toMatchObject({ state: "active" });
  expect(await f.db.select().from(schema.identityCreatorCapabilityEvents).where(and(eq(schema.identityCreatorCapabilityEvents.penaltyId, c.penaltyId), eq(schema.identityCreatorCapabilityEvents.action, "reinstated")))).toMatchObject([
    { state: "active", reasonCode: "penalty_expired", actorUserId: null, actorSessionId: null }]);
});

test("expiring an account suspension preserves another active creator suspension", async () => {
  const c = await expiring({ kind: "suspension", target: "account" });
  const second = await c.service.apply({ ...await c.command(), kind: "suspension", target: "creator_capability" });
  await createEnforcementMaintenance({ db: f.db, penalties: c.penalties, mode: "enabled", now: () => at }).runOnce();
  expect((await f.db.select().from(schema.identityCreatorCapabilities).where(eq(schema.identityCreatorCapabilities.id, c.capabilityId)))[0]?.state).toBe("suspended");
  expect((await f.db.select().from(schema.trustPenalties).where(eq(schema.trustPenalties.id, second.penaltyId)))[0]?.state).toBe("active");
});

test("expiry preserves the legacy suspended capability baseline (R9)", async () => {
  const c = await penaltyContext(f);
  await f.db.transaction(async (tx) => {
    await c.input.fence.lockCreatorFence(tx, c.p.creator.userId); await c.identity.lockSubject(tx, c.p.creator.userId);
    await tx.update(schema.identityCreatorCapabilities).set({ state: "suspended", version: 2, suspendedAt: reportAt, updatedAt: reportAt })
      .where(eq(schema.identityCreatorCapabilities.id, c.capabilityId));
    await recordCreatorCapabilityChange(tx, { userId: c.p.creator.userId, capabilityId: c.capabilityId, previousState: "active", state: "suspended", version: 2,
      penaltyId: null, actor: { ...c.owner, stepUpProofId: randomUUID() }, reasonCode: "legacy_suspend", requestId: randomUUID(), at: reportAt });
  });
  const { penaltyId } = await c.service.apply({ ...await c.command(), kind: "suspension", target: "creator_capability", endsAt: at.toISOString() });
  const penalties = createPenaltyService({ ...c.input, now: () => at });
  expect(await createEnforcementMaintenance({ db: f.db, penalties, mode: "enabled", now: () => at }).runOnce()).toMatchObject({ expired: 1 });
  expect((await f.db.select().from(schema.trustPenalties).where(eq(schema.trustPenalties.id, penaltyId)))[0]?.state).toBe("expired");
  expect((await f.db.select().from(schema.identityCreatorCapabilities).where(eq(schema.identityCreatorCapabilities.id, c.capabilityId)))[0]?.state).toBe("suspended");
});

test("a failing penalty does not stop the others; its transaction is rolled back and its ID counted", async () => {
  const first = await expiring(); const second = await expiring(); const onPenaltyFailure = vi.fn();
  const penalties = { end: vi.fn(async (...args: Parameters<typeof first.penalties.end>) => {
    const result = await first.penalties.end(...args);
    if (args[1].penaltyId === first.penaltyId) throw new Error("private failure contents");
    return result;
  }) };
  expect(await createEnforcementMaintenance({ db: f.db, penalties, mode: "enabled", now: () => at, onPenaltyFailure }).runOnce()).toMatchObject({ expired: 1 });
  expect(onPenaltyFailure.mock.calls).toEqual([[first.penaltyId]]);
  expect((await f.db.select().from(schema.trustPenalties).where(eq(schema.trustPenalties.id, first.penaltyId)))[0]?.state).toBe("active");
  expect((await f.db.select().from(schema.trustPenalties).where(eq(schema.trustPenalties.id, second.penaltyId)))[0]?.state).toBe("expired");
  expect(await f.db.select().from(schema.trustPenaltyEvents).where(and(eq(schema.trustPenaltyEvents.penaltyId, first.penaltyId), eq(schema.trustPenaltyEvents.action, "expired")))).toHaveLength(0);
  await createEnforcementMaintenance({ db: f.db, penalties: first.penalties, mode: "enabled", now: () => at }).runOnce();
});

test("scan is idempotent across two runs, with bounded batches", async () => {
  const first = await expiring(); const second = await expiring(); const third = await expiring();
  const scan = createEnforcementMaintenance({ db: f.db, penalties: first.penalties, mode: "enabled", now: () => at, batch: 2 });
  expect(await scan.runOnce()).toMatchObject({ expired: 2 }); expect(await scan.runOnce()).toMatchObject({ expired: 1 });
  expect(await scan.runOnce()).toEqual({ expired: 0, purgedSessions: 0, purgedRequests: 0 });
  for (const c of [first, second, third]) expect(await f.db.select().from(schema.trustPenaltyEvents).where(and(eq(schema.trustPenaltyEvents.penaltyId, c.penaltyId), eq(schema.trustPenaltyEvents.action, "expired")))).toHaveLength(1);
});

test("expiry locks the fence and subject before a penalty lock and skips a contended penalty", async () => {
  const c = await expiring(); const order: string[] = []; const onPenaltyFailure = vi.fn();
  const penalties = createPenaltyService({ ...c.input, now: () => at,
    fence: { async lockCreatorFence(tx, userId) { order.push("fence"); await c.input.fence.lockCreatorFence(tx, userId); } },
    identity: { ...c.identity, async lockSubject(tx, userId) { order.push("subject"); return c.identity.lockSubject(tx, userId); } } });
  const scan = createEnforcementMaintenance({ db: f.db, penalties, mode: "enabled", now: () => at, onPenaltyFailure });
  await f.db.transaction(async (tx) => {
    await tx.select().from(schema.trustPenalties).where(eq(schema.trustPenalties.id, c.penaltyId)).for("update");
    expect(await scan.runOnce()).toMatchObject({ expired: 0 });
    expect(order).toEqual(["fence", "subject"]); expect(onPenaltyFailure).not.toHaveBeenCalled();
    expect((await tx.select().from(schema.trustPenalties).where(eq(schema.trustPenalties.id, c.penaltyId)))[0]?.state).toBe("active");
  });
  expect(await scan.runOnce()).toMatchObject({ expired: 1 });
});

test("concurrent scans end each penalty once and do not report stale candidates as failures", async () => {
  const c = await expiring(); const onPenaltyFailure = vi.fn();
  const scan = createEnforcementMaintenance({ db: f.db, penalties: c.penalties, mode: "enabled", now: () => at, onPenaltyFailure });
  const results = await Promise.all([scan.runOnce(), scan.runOnce()]);
  expect(results.reduce((count, result) => count + result.expired, 0)).toBe(1);
  expect(onPenaltyFailure).not.toHaveBeenCalled();
  expect(await f.db.select().from(schema.trustPenaltyEvents).where(and(eq(schema.trustPenaltyEvents.penaltyId, c.penaltyId), eq(schema.trustPenaltyEvents.action, "expired")))).toHaveLength(1);
});

test("sessions and requests at expiry are deleted and links at read_until are revoked", async () => {
  const c = await expiring({ kind: "suspension", target: "account" }); const readAt = new Date(reportAt.getTime() + 90 * 86_400_000);
  const digest = () => `sha256:v1:${createHash("sha256").update(randomUUID()).digest("hex")}`;
  const [link] = await f.db.select().from(schema.trustHelpLinks).where(eq(schema.trustHelpLinks.penaltyId, c.penaltyId));
  const linkId = link!.id;
  const sessions = [randomUUID(), randomUUID()];
  await f.db.insert(schema.trustHelpSessions).values(sessions.map((id, i) => ({ id, sessionHash: digest(), linkId, userId: c.p.creator.userId, penaltyId: c.penaltyId,
    createdAt: new Date(readAt.getTime() - 1_800_000 + i), expiresAt: new Date(readAt.getTime() + i) })));
  const requests = [randomUUID(), randomUUID()]; const hmac = createLookupHmac({ key: fixtureLookupKey, context: "synthetic-maintenance", value: "synthetic" });
  await f.db.insert(schema.trustHelpLinkRequests).values(requests.map((id, i) => ({ id, addressHmac: hmac, networkKeyHmac: hmac, outcome: "ignored" as const,
    createdAt: new Date(readAt.getTime() - 60_000), expiresAt: new Date(readAt.getTime() + i) })));
  const scan = createEnforcementMaintenance({ db: f.db, penalties: c.penalties, mode: "enabled", now: () => readAt });
  expect(await scan.runOnce()).toEqual({ expired: 1, purgedSessions: 1, purgedRequests: 1 });
  expect((await f.db.select().from(schema.trustHelpLinks).where(eq(schema.trustHelpLinks.id, linkId)))[0]?.revokedAt).toEqual(readAt);
  for (const [table, ids] of [[schema.trustHelpSessions, sessions], [schema.trustHelpLinkRequests, requests]] as const) {
    expect(await f.db.select().from(table).where(eq(table.id, ids[0]!))).toHaveLength(0);
    expect(await f.db.select().from(table).where(eq(table.id, ids[1]!))).toHaveLength(1);
  }
  expect(await scan.runOnce()).toEqual({ expired: 0, purgedSessions: 0, purgedRequests: 0 });
});

test("disabled mode still expires penalties and records one pause, then enabled closes it", async () => {
  const c = await expiring({ kind: "suspension", target: "account" });
  const disabled = createPenaltyService({ ...c.input, mode: "disabled", now: () => at });
  const scan = createEnforcementMaintenance({ db: f.db, penalties: disabled, mode: "disabled", now: () => at });
  expect(await scan.runOnce()).toMatchObject({ expired: 1 }); await scan.runOnce();
  expect((await f.db.select().from(schema.identityUsers).where(eq(schema.identityUsers.id, c.p.creator.userId)))[0]?.accessStatus).toBe("active");
  expect(await f.db.select().from(schema.trustEnforcementPauses).where(isNull(schema.trustEnforcementPauses.endedAt))).toHaveLength(1);
  await createEnforcementMaintenance({ db: f.db, penalties: disabled, mode: "enabled", now: () => at }).runOnce();
  expect(await f.db.select().from(schema.trustEnforcementPauses).where(isNull(schema.trustEnforcementPauses.endedAt))).toHaveLength(0);
});
