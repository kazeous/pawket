import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { commissionFiles } from "@pawket/database";
import { noCommissionFileEvidenceHolds, runCommissionFileMaintenance, type CommissionFileOrderAccessPort } from "../src/index.js";
import { createFakeCommissionFileStorage } from "./fakes.js";
import { createCommissionFileFixture, fixtureAt } from "./file-fixture.js";

const fixture = createCommissionFileFixture("maintenance");
beforeAll(fixture.initialize, 60_000);
afterAll(fixture.dispose);
const HOUR = 3_600_000; const DAY = 24 * HOUR;
const facts = new Map<string, { state: string; confirmedAt: Date | null; closedAt: Date | null }>();
const orders: Pick<CommissionFileOrderAccessPort, "retentionFacts"> = { retentionFacts: async (_db, ids) => new Map(ids.filter((id) => facts.has(id)).map((id) => [id, facts.get(id)!])) };
function run(at: Date, options: Partial<Parameters<typeof runCommissionFileMaintenance>[0]> = {}) {
  const storage = createFakeCommissionFileStorage(); const enqueueScan = vi.fn(async () => undefined);
  return { storage, enqueueScan, report: runCommissionFileMaintenance({ db: fixture.db, storage: storage.port, orders, holds: noCommissionFileEvidenceHolds,
    retentionMode: "report_only", batchSize: 100, enqueueScan, now: () => at, ...options }) };
}

describe("commission file maintenance", () => {
  test("expires stale grants, discards unsent clean files and purges their bytes", async () => {
    const o = await fixture.order();
    const grant = await fixture.file({ ownerUserId: o.buyerUserId, packageId: o.packageId, state: "awaiting_upload" });
    const unsent = await fixture.file({ ownerUserId: o.buyerUserId, packageId: o.packageId });
    const at = new Date(fixtureAt.getTime() + DAY);
    const first = run(at); const report = await first.report;
    expect(report).toMatchObject({ expired: 1, discarded: 1 });
    expect(await fixture.read(grant)).toMatchObject({ state: "expired", endedAt: at });
    expect(await fixture.read(unsent)).toMatchObject({ state: "discarded", endedAt: at });
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
    expect(await fixture.read(late)).toMatchObject({ state: "scan_failed" });
    // A live (not yet expired) lease must never be recovered or enqueued: it means a scan is
    // genuinely in flight, possibly claimed by the real processor after this sweep's own
    // candidate selection ran.
    expect(await fixture.read(live)).toMatchObject({ state: "scanning", scanLeaseExpiresAt: liveLeaseExpiresAt, scanAttempts: 0 });
  });
  test("reports, then enforces, 30-day deletion for references of unpaid closed orders", async () => {
    const o = await fixture.order(); const fileId = await fixture.file({ ownerUserId: o.buyerUserId, packageId: o.packageId });
    await fixture.attach(fileId, o.orderId);
    facts.set(o.orderId, { state: "closed", confirmedAt: null, closedAt: fixtureAt });
    expect(await run(new Date(fixtureAt.getTime() + 29 * DAY)).report).toMatchObject({ retentionDue: 0 });
    expect(await run(new Date(fixtureAt.getTime() + 30 * DAY)).report).toMatchObject({ retentionDue: 1, retentionDeleted: 0 });
    expect((await fixture.read(fileId)).state).toBe("attached");
    const held = await run(new Date(fixtureAt.getTime() + 30 * DAY), { retentionMode: "enforce", holds: { hasEvidenceHold: async () => true } }).report;
    expect(held).toMatchObject({ retentionDeleted: 0 });
    expect(await run(new Date(fixtureAt.getTime() + 30 * DAY), { retentionMode: "enforce" }).report).toMatchObject({ retentionDeleted: 1 });
    expect(await fixture.read(fileId)).toMatchObject({ state: "deleted", sha256: expect.any(String) });
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
    facts.set(closed.orderId, { state: "closed", confirmedAt: null, closedAt: fixtureAt });
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
