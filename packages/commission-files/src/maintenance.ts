import { and, asc, count, eq, inArray, isNotNull, isNull, lte, min, or, sql, type SQL } from "drizzle-orm";
import { commissionFiles, type PawketDatabase } from "@pawket/database";

import { COMMISSION_FILE_POLICY } from "./file-policy.js";
import type { CommissionFileEvidenceHoldPort, CommissionFileOrderAccessPort } from "./ports.js";
import type { CommissionFileStoragePort } from "./storage-port.js";

export type CommissionFileMaintenanceReport = Readonly<{
  expired: number; discarded: number; scanFailed: number; recovered: number; enqueued: number;
  purged: number; purgeFailures: number; retentionDue: number; retentionDeleted: number;
  scanning: number; oldestScanningSeconds: number | null;
}>;
const TERMINAL = ["rejected", "scan_failed", "expired", "discarded", "deleted"] as const;

/**
 * Run periodically by the worker. Every step below is its own statement (never one enclosing
 * transaction): the purge loop makes network calls to object storage between database writes, and
 * holding a transaction open across that I/O would be an anti-pattern. Each UPDATE re-asserts the
 * originating state in its own WHERE clause so a row a concurrent run already moved past is simply
 * left alone instead of silently clobbered.
 */
export async function runCommissionFileMaintenance(input: Readonly<{
  db: PawketDatabase; storage: Pick<CommissionFileStoragePort, "deleteAllVersions">;
  orders: Pick<CommissionFileOrderAccessPort, "retentionFacts">; holds: CommissionFileEvidenceHoldPort;
  retentionMode: "report_only" | "enforce"; batchSize: number;
  enqueueScan(fileId: string, attempt: number): Promise<void>; now?: () => Date;
}>): Promise<CommissionFileMaintenanceReport> {
  if (!Number.isInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > 500) throw new Error("Invalid commission file maintenance batch");
  const at = (input.now ?? (() => new Date()))();
  // The `postgres` driver rejects a raw JS Date interpolated into a `sql` template, so `updatedAt`
  // is widened through an ISO string with an explicit cast; plain `.set()`/`eq()`/`lte()` calls
  // elsewhere in this file take Dates directly and need no such conversion.
  const bump = { version: sql`${commissionFiles.version} + 1`, updatedAt: sql`greatest(${commissionFiles.updatedAt}, ${at.toISOString()}::timestamptz)` };
  // The postgres-js driver does not reliably accept a select subquery as the right-hand side of
  // `inArray`, so every batch is materialised to a plain ID array first, then applied with a
  // second bulk UPDATE — the same two-step shape as `expireOidcTransientData`.
  const materialize = async (where: SQL | undefined): Promise<readonly string[]> =>
    (await input.db.select({ id: commissionFiles.id }).from(commissionFiles).where(where)
      .orderBy(asc(commissionFiles.updatedAt), asc(commissionFiles.id)).limit(input.batchSize)).map((row) => row.id);
  const leaseFree = or(isNull(commissionFiles.scanLeaseExpiresAt), lte(commissionFiles.scanLeaseExpiresAt, at));

  const expiredIds = await materialize(and(eq(commissionFiles.state, "awaiting_upload"), lte(commissionFiles.uploadExpiresAt, at)));
  if (expiredIds.length) await input.db.update(commissionFiles).set({ state: "expired", endedAt: at, ...bump })
    .where(and(inArray(commissionFiles.id, expiredIds), eq(commissionFiles.state, "awaiting_upload")));

  const discardedIds = await materialize(and(eq(commissionFiles.state, "clean"), lte(commissionFiles.cleanAt, new Date(at.getTime() - COMMISSION_FILE_POLICY.unsentTtlMs))));
  if (discardedIds.length) await input.db.update(commissionFiles).set({ state: "discarded", endedAt: at, ...bump })
    .where(and(inArray(commissionFiles.id, discardedIds), eq(commissionFiles.state, "clean")));

  const scanFailedIds = await materialize(and(eq(commissionFiles.state, "scanning"), lte(commissionFiles.scanDeadlineAt, at), leaseFree));
  if (scanFailedIds.length) await input.db.update(commissionFiles).set({ state: "scan_failed", endedAt: at, nextScanAt: null, scanLeaseExpiresAt: null, ...bump })
    .where(and(inArray(commissionFiles.id, scanFailedIds), eq(commissionFiles.state, "scanning")));

  // A lease that expired means a worker died mid-scan. A new attempt number gives the queue a fresh job ID.
  const recoveredIds = await materialize(and(eq(commissionFiles.state, "scanning"), isNotNull(commissionFiles.scanLeaseExpiresAt), lte(commissionFiles.scanLeaseExpiresAt, at)));
  if (recoveredIds.length) await input.db.update(commissionFiles).set({ scanLeaseExpiresAt: null, nextScanAt: at, scanAttempts: sql`${commissionFiles.scanAttempts} + 1`, ...bump })
    .where(and(inArray(commissionFiles.id, recoveredIds), eq(commissionFiles.state, "scanning")));

  const due = await input.db.select({ id: commissionFiles.id, attempts: commissionFiles.scanAttempts }).from(commissionFiles)
    .where(and(eq(commissionFiles.state, "scanning"), isNull(commissionFiles.scanLeaseExpiresAt), or(isNull(commissionFiles.nextScanAt), lte(commissionFiles.nextScanAt, at))))
    .orderBy(asc(commissionFiles.nextScanAt), asc(commissionFiles.id)).limit(input.batchSize);
  for (const file of due) await input.enqueueScan(file.id, file.attempts);

  // Terminal files are purged from both buckets; live clean/attached files only have their
  // quarantine copy purged (the scan processor already purges it on success — this is the
  // retry path for when that best-effort purge failed), and only after a grace period so a
  // scan that is about to retry never races a purge of bytes it still needs.
  let purged = 0; let purgeFailures = 0;
  const purgeCandidates = await input.db.select().from(commissionFiles).where(or(
    and(inArray(commissionFiles.state, [...TERMINAL]), or(isNull(commissionFiles.quarantinePurgedAt), isNull(commissionFiles.cleanPurgedAt))),
    and(inArray(commissionFiles.state, ["clean", "attached"]), isNull(commissionFiles.quarantinePurgedAt), lte(commissionFiles.cleanAt, new Date(at.getTime() - 300_000))),
  )).orderBy(asc(commissionFiles.updatedAt), asc(commissionFiles.id)).limit(input.batchSize);
  for (const file of purgeCandidates) {
    const terminal = (TERMINAL as readonly string[]).includes(file.state);
    try {
      if (!file.quarantinePurgedAt) await input.storage.deleteAllVersions("quarantine", file.objectKey);
      if (terminal && !file.cleanPurgedAt) await input.storage.deleteAllVersions("clean", file.objectKey);
      await input.db.update(commissionFiles).set({
        ...(file.quarantinePurgedAt ? {} : { quarantinePurgedAt: at }),
        ...(terminal && !file.cleanPurgedAt ? { cleanPurgedAt: at } : {}),
        ...bump,
      }).where(and(eq(commissionFiles.id, file.id), eq(commissionFiles.state, file.state)));
      purged += 1;
    } catch { purgeFailures += 1; }
  }

  // I7 Stage A: only references of orders closed before payment expire. Stage B adds the terminal-order rule.
  let retentionDue = 0; let retentionDeleted = 0;
  const attached = await input.db.select({ id: commissionFiles.id, orderId: commissionFiles.orderId }).from(commissionFiles)
    .where(eq(commissionFiles.state, "attached")).orderBy(asc(commissionFiles.attachedAt), asc(commissionFiles.id)).limit(input.batchSize);
  const facts = await input.orders.retentionFacts(input.db, attached.map((file) => file.orderId!));
  for (const file of attached) {
    const order = facts.get(file.orderId!);
    if (!order || order.state !== "closed" || order.confirmedAt !== null || !order.closedAt || order.closedAt.getTime() + COMMISSION_FILE_POLICY.closedUnpaidRetentionMs > at.getTime()) continue;
    if (await input.holds.hasEvidenceHold(input.db, file.orderId!)) continue;
    retentionDue += 1;
    if (input.retentionMode !== "enforce") continue;
    const [deleted] = await input.db.update(commissionFiles).set({ state: "deleted", endedAt: at, ...bump })
      .where(and(eq(commissionFiles.id, file.id), eq(commissionFiles.state, "attached"))).returning({ id: commissionFiles.id });
    if (deleted) retentionDeleted += 1;
  }

  const [backlog] = await input.db.select({ total: count(), oldest: min(commissionFiles.uploadedAt) }).from(commissionFiles).where(eq(commissionFiles.state, "scanning"));
  const oldest = backlog?.oldest ?? null;
  return {
    expired: expiredIds.length, discarded: discardedIds.length, scanFailed: scanFailedIds.length, recovered: recoveredIds.length, enqueued: due.length,
    purged, purgeFailures, retentionDue, retentionDeleted, scanning: Number(backlog?.total ?? 0),
    oldestScanningSeconds: oldest ? Math.max(0, Math.floor((at.getTime() - oldest.getTime()) / 1000)) : null,
  };
}
