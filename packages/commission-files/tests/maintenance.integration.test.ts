import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { commissionFiles } from "@pawket/database";
import { encryptCommissionFileName, noCommissionFileEvidenceHolds, runCommissionFileMaintenance, type CommissionFileOrderAccessPort, type CommissionFileRetentionFacts } from "../src/index.js";
import { createFakeCommissionFileStorage } from "./fakes.js";
import { createCommissionFileFixture, fixtureAt, fixtureKeyring } from "./file-fixture.js";

const fixture = createCommissionFileFixture("maintenance");
beforeAll(fixture.initialize, 60_000);
afterAll(fixture.dispose);
const task10Fixture = createCommissionFileFixture("maintenance_task10");
beforeAll(task10Fixture.initialize, 60_000);
afterAll(task10Fixture.dispose);
const HOUR = 3_600_000; const DAY = 24 * HOUR;
const facts = new Map<string, CommissionFileRetentionFacts>();
const orders: Pick<CommissionFileOrderAccessPort, "retentionFacts"> = { retentionFacts: async (_db, ids) => new Map(ids.filter((id) => facts.has(id)).map((id) => [id, facts.get(id)!])) };
function run(at: Date, options: Partial<Parameters<typeof runCommissionFileMaintenance>[0]> = {}) {
  const storage = createFakeCommissionFileStorage(); const enqueueScan = vi.fn(async () => undefined);
  return { storage, enqueueScan, report: runCommissionFileMaintenance({ db: fixture.db, storage: storage.port, orders, holds: noCommissionFileEvidenceHolds,
    retentionMode: "report_only", batchSize: 100, enqueueScan, now: () => at, ...options }) };
}

function runTask10(at: Date, options: Partial<Parameters<typeof runCommissionFileMaintenance>[0]> = {}) {
  return run(at, { db: task10Fixture.db, ...options });
}

async function completedFile() {
  const o = await task10Fixture.order(); const fileId = await task10Fixture.file({ ownerUserId: o.buyerUserId, packageId: o.packageId });
  await task10Fixture.attach(fileId, o.orderId);
  facts.set(o.orderId, { state: "completed", confirmedAt: fixtureAt, closedAt: null, completedAt: fixtureAt });
  return { orderId: o.orderId, fileId };
}
async function terminalCopyIntent(endedAt: Date) {
  const o = await task10Fixture.order(); const id = await task10Fixture.file({ ownerUserId: o.buyerUserId, packageId: o.packageId, state: "scanning", at: endedAt });
  await task10Fixture.db.update(commissionFiles).set({ cleanCopyIntent: true, version: 3, updatedAt: endedAt }).where(eq(commissionFiles.id, id));
  await task10Fixture.db.update(commissionFiles).set({ state: "discarded", endedAt, version: 4, updatedAt: endedAt }).where(eq(commissionFiles.id, id));
  return id;
}

describe("commission file maintenance", () => {
  test("files of a completed order are reported 180 days after completion", async () => {
    const { orderId } = await completedFile();
    try { expect((await runTask10(new Date(fixtureAt.getTime() + 180 * DAY)).report).retentionDue).toBe(1); }
    finally { facts.delete(orderId); }
  });
  test("completed-order files at 179 days are not due", async () => {
    const { orderId } = await completedFile();
    try { expect((await runTask10(new Date(fixtureAt.getTime() + 179 * DAY)).report).retentionDue).toBe(0); }
    finally { facts.delete(orderId); }
  });
  test("an evidence hold skips completed-order files", async () => {
    const { orderId, fileId } = await completedFile(); const hasEvidenceHold = vi.fn(async () => true);
    try {
      const report = await runTask10(new Date(fixtureAt.getTime() + 180 * DAY), { retentionMode: "enforce", holds: { hasEvidenceHold } }).report;
      expect(report.retentionDue).toBe(0); expect(report.retentionDeleted).toBe(0);
      expect(hasEvidenceHold.mock.calls.length).toBe(1);
      expect((await task10Fixture.read(fileId)).state).toBe("attached");
    } finally { facts.delete(orderId); }
  });
  test("report_only never deletes completed-order files", async () => {
    const { orderId, fileId } = await completedFile();
    try {
      const sweep = runTask10(new Date(fixtureAt.getTime() + 180 * DAY)); const remove = vi.spyOn(sweep.storage.port, "deleteAllVersions");
      expect((await sweep.report).retentionDeleted).toBe(0);
      expect((await task10Fixture.read(fileId)).state).toBe("attached");
      expect(remove.mock.calls.filter(([area]) => area === "clean").length).toBe(0);
    } finally { facts.delete(orderId); }
  });
  test("enforce marks completed-order files deleted", async () => {
    const { orderId, fileId } = await completedFile();
    try {
      const report = await runTask10(new Date(fixtureAt.getTime() + 180 * DAY), { retentionMode: "enforce" }).report;
      expect(report.retentionDue).toBe(1); expect(report.retentionDeleted).toBe(1);
      const row = await task10Fixture.read(fileId);
      expect(row.state).toBe("deleted"); expect(row.endedAt?.getTime()).toBe(fixtureAt.getTime() + 180 * DAY);
      expect(row.filenameEnvelope !== null).toBe(true); expect(row.sha256 !== null).toBe(true);
    } finally { facts.delete(orderId); }
  });
  test("a terminal copy-intent row is closed after 24 h and leaves the purge loop", async () => {
    const id = await terminalCopyIntent(fixtureAt); const at = new Date(fixtureAt.getTime() + DAY);
    const storage = createFakeCommissionFileStorage(); const key = `commission/${id}`;
    storage.put("clean", key, new Uint8Array([1])); storage.put("clean", key, new Uint8Array([2]));
    const remove = vi.spyOn(storage.port, "deleteAllVersions");
    const first = await runTask10(at, { storage: storage.port }).report;
    const row = await task10Fixture.read(id);
    expect(row.cleanCopyIntent).toBe(true); expect(row.cleanPurgedAt?.getTime()).toBe(at.getTime());
    expect(storage.has("clean", key)).toBe(false); expect(first.purged).toBeGreaterThan(0);
    const candidateCount = remove.mock.calls.filter(([area, objectKey]) => area === "clean" && objectKey === key).length;
    expect(candidateCount).toBe(1);
    const second = await runTask10(at, { storage: storage.port, batchSize: 1 }).report;
    expect(second.purged).toBe(0);
    expect(second.purgeNextAfter === null).toBe(true);
    expect(remove.mock.calls.filter(([area, objectKey]) => area === "clean" && objectKey === key).length).toBe(candidateCount);
    expect((await task10Fixture.read(id)).version).toBe(row.version);
  });
  test("a terminal copy-intent row younger than 24 h is still reconciled and not closed", async () => {
    const id = await terminalCopyIntent(new Date(fixtureAt.getTime() + 2 * DAY)); const at = new Date(fixtureAt.getTime() + 3 * DAY - 1);
    const storage = createFakeCommissionFileStorage(); const remove = vi.spyOn(storage.port, "deleteAllVersions"); const key = `commission/${id}`;
    await runTask10(at, { storage: storage.port }).report;
    expect((await task10Fixture.read(id)).cleanPurgedAt === null).toBe(true);
    storage.put("clean", key, new Uint8Array([1]));
    await runTask10(at, { storage: storage.port }).report;
    expect((await task10Fixture.read(id)).cleanPurgedAt === null).toBe(true);
    expect(storage.has("clean", key)).toBe(false);
    expect(remove.mock.calls.filter(([area, objectKey]) => area === "clean" && objectKey === key).length).toBe(2);
  });
  test("a failed clean purge does not close an aged copy-intent row", async () => {
    const endedAt = new Date(fixtureAt.getTime() + 4 * DAY); const id = await terminalCopyIntent(endedAt);
    const at = new Date(endedAt.getTime() + DAY); const storage = createFakeCommissionFileStorage();
    const actualDelete = storage.port.deleteAllVersions;
    vi.spyOn(storage.port, "deleteAllVersions").mockImplementation(async (area, key) => {
      if (area === "clean") throw new Error("storage unavailable");
      return actualDelete(area, key);
    });
    const report = await runTask10(at, { storage: storage.port }).report;
    expect(report.purgeFailures).toBeGreaterThan(0); expect(report.purged).toBe(0);
    expect((await task10Fixture.read(id)).cleanPurgedAt === null).toBe(true);
    await runTask10(at).report;
    expect((await task10Fixture.read(id)).cleanPurgedAt?.getTime()).toBe(at.getTime());
  });
  test("advances past a full failed page with database microsecond creation timestamps", async () => {
    const o = await fixture.order(); const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
    const preciseAt = "2026-09-28T03:00:00.000123Z";
    for (const id of ids) await fixture.db.insert(commissionFiles).values({ id, ownerUserId: o.buyerUserId, context: "brief", packageId: o.packageId,
      declaredBytes: 16, filenameEnvelope: encryptCommissionFileName(fixtureKeyring, id, "reference.png"), objectKey: `commission/${id}`, requestId: "fractional-fixture",
      createdAt: sql`${preciseAt}::timestamptz`, updatedAt: sql`${preciseAt}::timestamptz`, uploadExpiresAt: sql`${preciseAt}::timestamptz + interval '15 minutes'` });
    const storage = createFakeCommissionFileStorage(); const actualDelete = storage.port.deleteAllVersions;
    vi.spyOn(storage.port, "deleteAllVersions").mockImplementation(async (area, key) => {
      if (key !== `commission/${ids[2]}`) throw new Error("provider refusal");
      return actualDelete(area, key);
    });
    try {
      const first = await run(fixtureAt, { storage: storage.port, batchSize: 2 }).report;
      expect(first.purgeFailures).toBe(2);
      const second = await run(fixtureAt, { storage: storage.port, batchSize: 2, purgeAfter: first.purgeNextAfter }).report;
      expect(second.purgeFailures).toBe(0);
      expect(await fixture.read(ids[2]!)).toMatchObject({ cleanPurgedAt: expect.any(Date) });
      expect(second.purgeNextAfter).toBeNull();
    } finally { await run(fixtureAt).report; }
  });
  test("advances beyond an entire failing purge batch and retries failures after wrapping", async () => {
    const o = await fixture.order(); const ids: string[] = [];
    // Earlier than other fixture rows, with strictly ordered immutable creation times.
    const at = new Date(fixtureAt.getTime() - DAY);
    for (let i = 0; i < 3; i++) ids.push(await fixture.file({ ownerUserId: o.buyerUserId, packageId: o.packageId, state: "awaiting_upload", at: new Date(at.getTime() + i) }));
    const storage = createFakeCommissionFileStorage(); const actualDelete = storage.port.deleteAllVersions;
    const remove = vi.spyOn(storage.port, "deleteAllVersions").mockImplementation(async (area, key) => {
      if (ids.slice(0, 2).some((id) => key === `commission/${id}`)) throw new Error("permanent provider refusal");
      return actualDelete(area, key);
    });
    const first = await run(fixtureAt, { storage: storage.port, batchSize: 2 }).report;
    expect(first.purgeFailures).toBe(2); expect(first.purgeNextAfter).not.toBeNull();
    const second = await run(fixtureAt, { storage: storage.port, batchSize: 2, purgeAfter: first.purgeNextAfter }).report;
    expect(await fixture.read(ids[2]!)).toMatchObject({ cleanPurgedAt: expect.any(Date), quarantinePurgedAt: expect.any(Date), filenameEnvelope: null });
    expect(second.purgeNextAfter).toBeNull();
    expect(await run(fixtureAt, { storage: storage.port, batchSize: 2, purgeAfter: second.purgeNextAfter }).report).toMatchObject({ purgeFailures: 2 });
    expect(remove.mock.calls.filter(([, key]) => key === `commission/${ids[0]}`).length).toBe(2);
  });
  test("expires stale grants, discards unsent clean files and purges their bytes", async () => {
    const o = await fixture.order();
    const grant = await fixture.file({ ownerUserId: o.buyerUserId, packageId: o.packageId, state: "awaiting_upload" });
    const unsent = await fixture.file({ ownerUserId: o.buyerUserId, packageId: o.packageId });
    const at = new Date(fixtureAt.getTime() + DAY);
    const first = run(at); const report = await first.report;
    expect(report).toMatchObject({ expired: 1, discarded: 1 });
    expect(await fixture.read(grant)).toMatchObject({ state: "expired", endedAt: at, filenameEnvelope: null });
    expect(await fixture.read(unsent)).toMatchObject({ state: "discarded", endedAt: at, filenameEnvelope: null });
    await (run(new Date(at.getTime() + 1_000)).report);
    expect(await fixture.read(grant)).toMatchObject({ quarantinePurgedAt: expect.any(Date), cleanPurgedAt: expect.any(Date) });
    expect(await fixture.read(unsent)).toMatchObject({ quarantinePurgedAt: expect.any(Date), cleanPurgedAt: expect.any(Date) });
  });
  test("re-enqueues due scans, recovers expired leases and fails scans past the deadline", async () => {
    const o = await fixture.order();
    const due = await fixture.file({ ownerUserId: o.buyerUserId, packageId: o.packageId, state: "scanning" });
    const stuck = await fixture.file({ ownerUserId: o.buyerUserId, packageId: o.packageId, state: "scanning" });
    const row = await fixture.read(stuck);
    await fixture.db.update(commissionFiles).set({ scanLeaseExpiresAt: new Date(fixtureAt.getTime() + 60_000), version: row.version + 1 }).where(eq(commissionFiles.id, stuck));
    const late = await fixture.file({ ownerUserId: o.buyerUserId, packageId: o.packageId, state: "scanning", at: new Date(fixtureAt.getTime() - DAY) });
    const live = await fixture.file({ ownerUserId: o.buyerUserId, packageId: o.packageId, state: "scanning" });
    const liveRow = await fixture.read(live);
    const liveLeaseExpiresAt = new Date(fixtureAt.getTime() + 10 * 60_000);
    await fixture.db.update(commissionFiles).set({ scanLeaseExpiresAt: liveLeaseExpiresAt, version: liveRow.version + 1 }).where(eq(commissionFiles.id, live));
    const { enqueueScan, report } = run(new Date(fixtureAt.getTime() + 120_000));
    expect(await report).toMatchObject({ recovered: 1 });
    expect(enqueueScan).toHaveBeenCalledWith(due, 0);
    expect(enqueueScan).toHaveBeenCalledWith(stuck, 1);
    expect(enqueueScan).not.toHaveBeenCalledWith(live, expect.anything());
    expect(await fixture.read(stuck)).toMatchObject({ scanAttempts: 1, scanLeaseExpiresAt: null });
    expect(await fixture.read(late)).toMatchObject({ state: "scan_failed", filenameEnvelope: null });
    // A live (not yet expired) lease must never be recovered or enqueued: it means a scan is
    // genuinely in flight, possibly claimed by the real processor after this sweep's own
    // candidate selection ran.
    expect(await fixture.read(live)).toMatchObject({ state: "scanning", scanLeaseExpiresAt: liveLeaseExpiresAt, scanAttempts: 0 });
  });
  test("reports, then enforces, 30-day deletion for references of unpaid closed orders", async () => {
    const o = await fixture.order(); const fileId = await fixture.file({ ownerUserId: o.buyerUserId, packageId: o.packageId });
    await fixture.attach(fileId, o.orderId);
    facts.set(o.orderId, { state: "closed", confirmedAt: null, closedAt: fixtureAt, completedAt: null });
    expect(await run(new Date(fixtureAt.getTime() + 29 * DAY)).report).toMatchObject({ retentionDue: 0 });
    expect(await run(new Date(fixtureAt.getTime() + 30 * DAY)).report).toMatchObject({ retentionDue: 1, retentionDeleted: 0 });
    expect((await fixture.read(fileId)).state).toBe("attached");
    const held = await run(new Date(fixtureAt.getTime() + 30 * DAY), { retentionMode: "enforce", holds: { hasEvidenceHold: async () => true } }).report;
    expect(held).toMatchObject({ retentionDeleted: 0 });
    expect(await run(new Date(fixtureAt.getTime() + 30 * DAY), { retentionMode: "enforce" }).report).toMatchObject({ retentionDeleted: 1 });
    expect(await fixture.read(fileId)).toMatchObject({ state: "deleted", sha256: expect.any(String), filenameEnvelope: expect.any(Object) });
  });
  test("counts purge failures without failing the sweep", async () => {
    const o = await fixture.order(); await fixture.file({ ownerUserId: o.buyerUserId, packageId: o.packageId, state: "awaiting_upload" });
    const storage = createFakeCommissionFileStorage(); vi.spyOn(storage.port, "deleteAllVersions").mockRejectedValue(new Error("storage down"));
    const report = await runCommissionFileMaintenance({ db: fixture.db, storage: storage.port, orders, holds: noCommissionFileEvidenceHolds, retentionMode: "report_only",
      batchSize: 100, enqueueScan: async () => undefined, now: () => new Date(fixtureAt.getTime() + 40 * DAY) });
    expect(report.expired).toBeGreaterThan(0);
    expect(report.purgeFailures).toBeGreaterThan(0);
  });
  test("keyset-paginates retention past a backlog of attached files that never become eligible", async () => {
    const open = await fixture.order();
    const closed = await fixture.order();
    const fillerIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const fileId = await fixture.file({ ownerUserId: open.buyerUserId, packageId: open.packageId });
      await fixture.attach(fileId, open.orderId, i, new Date(fixtureAt.getTime() + i));
      fillerIds.push(fileId);
    }
    // Never registered in `facts` (not closed), and the order-level filter can't see it at the SQL
    // level: these three stay `attached` forever, exactly the backlog the retention sweep must
    // page past instead of starving on.
    const eligibleId = await fixture.file({ ownerUserId: closed.buyerUserId, packageId: closed.packageId });
    await fixture.attach(eligibleId, closed.orderId, 0, new Date(fixtureAt.getTime() + 10));
    facts.set(closed.orderId, { state: "closed", confirmedAt: null, closedAt: fixtureAt, completedAt: null });
    const at = new Date(fixtureAt.getTime() + 30 * DAY);

    const page1 = await run(at, { batchSize: 2 }).report;
    expect(page1).toMatchObject({ retentionDue: 0 });
    expect(page1.retentionNextAfter).not.toBeNull();

    const page2 = await run(at, { batchSize: 2, retentionMode: "enforce", retentionAfter: page1.retentionNextAfter }).report;
    expect(page2).toMatchObject({ retentionDue: 1, retentionDeleted: 1 });
    expect(page2.retentionNextAfter).not.toBeNull();
    expect(await fixture.read(eligibleId)).toMatchObject({ state: "deleted" });

    const page3 = await run(at, { batchSize: 2, retentionAfter: page2.retentionNextAfter }).report;
    expect(page3).toMatchObject({ retentionDue: 0, retentionNextAfter: null });

    // Restarting from the top (no cursor) still sees the never-eligible backlog and nothing else
    // (the eligible file is `deleted` now, not `attached`, so it is gone from every future page).
    const restarted = await run(at, { batchSize: 2 }).report;
    expect(restarted).toMatchObject({ retentionDue: 0 });
  });
});
