import { and, asc, count, eq, gt, inArray, isNotNull, isNull, lte, min, notInArray, or, sql, type SQL } from "drizzle-orm";
import { commissionFiles, type PawketDatabase } from "@pawket/database";

import { COMMISSION_FILE_POLICY, commissionFileUuid } from "./file-policy.js";
import type { CommissionFileEvidenceHoldPort, CommissionFileOrderAccessPort } from "./ports.js";
import type { CommissionFileStoragePort } from "./storage-port.js";

export type CommissionFileRetentionCursor = Readonly<{ attachedAt: Date; id: string }>;
export type CommissionFilePurgeCursor = Readonly<{ createdAt: Date; id: string }>;
export type CommissionFileMaintenanceReport = Readonly<{
  expired: number; discarded: number; scanFailed: number; recovered: number; enqueued: number;
  purged: number; purgeFailures: number; purgeNextAfter: CommissionFilePurgeCursor | null; retentionDue: number; retentionDeleted: number; retentionNextAfter: CommissionFileRetentionCursor | null;
  scanning: number; oldestScanningSeconds: number | null;
}>;
const TERMINAL = ["rejected", "scan_failed", "expired", "discarded", "deleted"] as const;
const COPY_INTENT_CLOSURE_MS = 24 * 60 * 60 * 1_000;

/**
 * Run periodically by the worker. Every step below is its own statement (never one enclosing
 * transaction): the purge loop makes network calls to object storage between database writes, and
 * holding a transaction open across that I/O would be an anti-pattern. Each bulk UPDATE re-applies
 * the *exact* predicate used to select its batch (not just the originating state), so a row a
 * concurrent writer already moved past — most importantly the scan processor claiming, renewing or
 * releasing a lease between this function's SELECT and its UPDATE — is left alone instead of
 * double-processed. Counts are always taken from `.returning()`, never from the (possibly now
 * stale) selected id list.
 */
export async function runCommissionFileMaintenance(input: Readonly<{
  db: PawketDatabase; storage: Pick<CommissionFileStoragePort, "deleteAllVersions">;
  orders: Pick<CommissionFileOrderAccessPort, "retentionFacts">; holds: CommissionFileEvidenceHoldPort;
  retentionMode: "report_only" | "enforce"; batchSize: number; retentionAfter?: CommissionFileRetentionCursor | null;
  purgeAfter?: CommissionFilePurgeCursor | null;
  enqueueScan(fileId: string, attempt: number): Promise<void>; now?: () => Date;
}>): Promise<CommissionFileMaintenanceReport> {
  if (!Number.isInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > 500) throw new Error("Invalid commission file maintenance batch");
  if (input.purgeAfter != null && (!(input.purgeAfter.createdAt instanceof Date) || Number.isNaN(input.purgeAfter.createdAt.getTime()) || !commissionFileUuid(input.purgeAfter.id))) {
    throw new Error("Invalid commission file maintenance purge cursor");
  }
  if (input.retentionAfter != null && (!(input.retentionAfter.attachedAt instanceof Date) || Number.isNaN(input.retentionAfter.attachedAt.getTime()) || !commissionFileUuid(input.retentionAfter.id))) {
    throw new Error("Invalid commission file maintenance retention cursor");
  }
  const at = (input.now ?? (() => new Date()))();
  // The `postgres` driver rejects a raw JS Date interpolated into a `sql` template, so `updatedAt`
  // is widened through an ISO string with an explicit cast; plain `.set()`/`eq()`/`lte()`/`gt()`
  // calls elsewhere in this file take Dates directly and need no such conversion.
  const bump = { version: sql`${commissionFiles.version} + 1`, updatedAt: sql`greatest(${commissionFiles.updatedAt}, ${at.toISOString()}::timestamptz)` };
  // The postgres-js driver does not reliably accept a select subquery as the right-hand side of
  // `inArray`, so every batch is materialised to a plain ID array first, then applied with a
  // second bulk UPDATE — the same two-step shape as `expireOidcTransientData`. The *same* predicate
  // object is reused for that second UPDATE's WHERE (see module doc comment above).
  const materialize = async (where: SQL | undefined): Promise<readonly string[]> =>
    (await input.db.select({ id: commissionFiles.id }).from(commissionFiles).where(where)
      .orderBy(asc(commissionFiles.updatedAt), asc(commissionFiles.id)).limit(input.batchSize)).map((row) => row.id);
  const leaseFree = or(isNull(commissionFiles.scanLeaseExpiresAt), lte(commissionFiles.scanLeaseExpiresAt, at));

  const expiredWhere = and(eq(commissionFiles.state, "awaiting_upload"), lte(commissionFiles.uploadExpiresAt, at));
  const expiredIds = await materialize(expiredWhere);
  const expired = expiredIds.length ? await input.db.update(commissionFiles).set({ state: "expired", endedAt: at, ...bump })
    .where(and(inArray(commissionFiles.id, expiredIds), expiredWhere)).returning({ id: commissionFiles.id }) : [];

  const discardedWhere = and(eq(commissionFiles.state, "clean"), lte(commissionFiles.cleanAt, new Date(at.getTime() - COMMISSION_FILE_POLICY.unsentTtlMs)));
  const discardedIds = await materialize(discardedWhere);
  const discarded = discardedIds.length ? await input.db.update(commissionFiles).set({ state: "discarded", endedAt: at, ...bump })
    .where(and(inArray(commissionFiles.id, discardedIds), discardedWhere)).returning({ id: commissionFiles.id }) : [];

  const scanFailedWhere = and(eq(commissionFiles.state, "scanning"), lte(commissionFiles.scanDeadlineAt, at), leaseFree);
  const scanFailedIds = await materialize(scanFailedWhere);
  const scanFailed = scanFailedIds.length ? await input.db.update(commissionFiles).set({ state: "scan_failed", endedAt: at, nextScanAt: null, scanLeaseExpiresAt: null, ...bump })
    .where(and(inArray(commissionFiles.id, scanFailedIds), scanFailedWhere)).returning({ id: commissionFiles.id }) : [];

  // A lease that expired means a worker died mid-scan. A new attempt number gives the queue a fresh
  // job ID. The UPDATE re-checks the lease is *still* expired at write time: if the scan processor
  // claimed, renewed, or already released (via its own retry()) the lease in between, this predicate
  // no longer matches and the row is correctly left alone instead of yanked out from under live work.
  const recoveredWhere = and(eq(commissionFiles.state, "scanning"), isNotNull(commissionFiles.scanLeaseExpiresAt), lte(commissionFiles.scanLeaseExpiresAt, at));
  const recoveredIds = await materialize(recoveredWhere);
  const recovered = recoveredIds.length ? await input.db.update(commissionFiles).set({ scanLeaseExpiresAt: null, nextScanAt: at, scanAttempts: sql`${commissionFiles.scanAttempts} + 1`, ...bump })
    .where(and(inArray(commissionFiles.id, recoveredIds), recoveredWhere)).returning({ id: commissionFiles.id, attempts: commissionFiles.scanAttempts }) : [];

  // Recovered rows already carry their post-increment attempt count from `returning()`. The fresh
  // due-select below is only for rows that never needed recovery, and explicitly excludes the
  // recovered ids so a row already enqueued above is never enqueued a second time from a stale
  // re-read of "scanning" state.
  const dueLimit = Math.max(0, input.batchSize - recovered.length);
  const dueWhere = and(eq(commissionFiles.state, "scanning"), isNull(commissionFiles.scanLeaseExpiresAt), or(isNull(commissionFiles.nextScanAt), lte(commissionFiles.nextScanAt, at)),
    recovered.length ? notInArray(commissionFiles.id, recovered.map((row) => row.id)) : undefined);
  const due = dueLimit > 0 ? await input.db.select({ id: commissionFiles.id, attempts: commissionFiles.scanAttempts }).from(commissionFiles)
    .where(dueWhere).orderBy(asc(commissionFiles.nextScanAt), asc(commissionFiles.id)).limit(dueLimit) : [];
  const toEnqueue = [...recovered, ...due];
  for (const file of toEnqueue) await input.enqueueScan(file.id, file.attempts);

  // Terminal files are purged from both buckets; live clean/attached files only have their
  // quarantine copy purged (the scan processor already purges it on success — this is the retry
  // path for when that best-effort purge failed), and only after a grace period so a scan that is
  // about to retry never races a purge of bytes it still needs. Each per-file UPDATE re-asserts
  // `isNull` on exactly the fields it is about to set, so a field a concurrent writer already
  // purged since the batch was read never trips the purge-timestamp immutability guard — the WHERE
  // simply fails to match, and the row is left for the next sweep, counted as neither purged nor
  // failed.
  let purged = 0; let purgeFailures = 0;
  // Immutable creation order makes failed rows and pending copy reconciliation fair:
  // every full page advances, and a short page wraps so earlier failures remain retryable.
  // PostgreSQL defaults can have microseconds; JS Date cursors only retain milliseconds.
  // Normalize BOTH sort and seek, otherwise a fractional first page can repeat forever.
  const purgeCreatedAt = sql`date_trunc('milliseconds', ${commissionFiles.createdAt})`;
  const purgeCursor = input.purgeAfter;
  const purgeCandidates = await input.db.select().from(commissionFiles).where(and(or(
    and(inArray(commissionFiles.state, [...TERMINAL]), or(isNull(commissionFiles.quarantinePurgedAt), isNull(commissionFiles.cleanPurgedAt))),
    and(inArray(commissionFiles.state, ["clean", "attached"]), isNull(commissionFiles.quarantinePurgedAt), lte(commissionFiles.cleanAt, new Date(at.getTime() - 300_000))),
  ), purgeCursor ? sql`(${purgeCreatedAt} > ${purgeCursor.createdAt.toISOString()}::timestamptz or
    (${purgeCreatedAt} = ${purgeCursor.createdAt.toISOString()}::timestamptz and ${commissionFiles.id} > ${purgeCursor.id}::uuid))` : undefined))
    .orderBy(asc(purgeCreatedAt), asc(commissionFiles.id)).limit(input.batchSize);
  for (const file of purgeCandidates) {
    const terminal = (TERMINAL as readonly string[]).includes(file.state);
    const needsQuarantine = !file.quarantinePurgedAt;
    const needsClean = terminal && !file.cleanPurgedAt;
    const canMarkClean = needsClean && (!file.cleanCopyIntent || (file.endedAt !== null && file.endedAt.getTime() <= at.getTime() - COPY_INTENT_CLOSURE_MS));
    try {
      if (needsQuarantine) await input.storage.deleteAllVersions("quarantine", file.objectKey);
      if (needsClean) await input.storage.deleteAllVersions("clean", file.objectKey);
      const guard = and(
        ...(needsQuarantine ? [isNull(commissionFiles.quarantinePurgedAt)] : []),
        ...(canMarkClean ? [isNull(commissionFiles.cleanPurgedAt)] : []),
      );
      const [marked] = await input.db.update(commissionFiles).set({
        ...(needsQuarantine ? { quarantinePurgedAt: at } : {}),
        // A cancelled copy can finish provider-side, so reconcile terminal intent rows for
        // 24 hours before recording final purge. S3 calls are capped at 60 seconds.
        ...(canMarkClean ? { cleanPurgedAt: at } : {}),
        ...bump,
      }).where(and(eq(commissionFiles.id, file.id), eq(commissionFiles.state, file.state), guard)).returning({ id: commissionFiles.id });
      if (marked && (!needsClean || canMarkClean)) purged += 1;
    } catch { purgeFailures += 1; }
  }
  const purgeNextAfter: CommissionFilePurgeCursor | null = purgeCandidates.length === input.batchSize
    ? { createdAt: purgeCandidates[purgeCandidates.length - 1]!.createdAt, id: purgeCandidates[purgeCandidates.length - 1]!.id } : null;

  // Closed-unpaid references and completed-order files have distinct retention periods.
  // Files attached to orders without an eligible terminal outcome stay `attached`, so
  // a plain unbounded scan would let that backlog fill every batch once it exceeds batchSize and
  // never reach closed-unpaid files attached afterwards. Keyset pagination on (attachedAt, id) walks
  // past that backlog across runs instead: `retentionNextAfter` is only set when the page was full
  // (there may be more after it); a short page means this pass reached the current end, and the
  // worker restarts from the beginning (no cursor) on its next run.
  let retentionDue = 0; let retentionDeleted = 0;
  const retentionCursor = input.retentionAfter;
  const retentionWhere = retentionCursor
    ? and(eq(commissionFiles.state, "attached"), or(
        gt(commissionFiles.attachedAt, retentionCursor.attachedAt),
        and(eq(commissionFiles.attachedAt, retentionCursor.attachedAt), gt(commissionFiles.id, retentionCursor.id)),
      ))
    : eq(commissionFiles.state, "attached");
  const attached = await input.db.select({ id: commissionFiles.id, orderId: commissionFiles.orderId, attachedAt: commissionFiles.attachedAt }).from(commissionFiles)
    .where(retentionWhere).orderBy(asc(commissionFiles.attachedAt), asc(commissionFiles.id)).limit(input.batchSize);
  const facts = await input.orders.retentionFacts(input.db, attached.map((file) => file.orderId!));
  for (const file of attached) {
    const order = facts.get(file.orderId!);
    if (!order) continue;
    const closedUnpaidDue = order.state === "closed" && order.confirmedAt === null && order.closedAt !== null
      && order.closedAt.getTime() + COMMISSION_FILE_POLICY.closedUnpaidRetentionMs <= at.getTime();
    const completedDue = order.state === "completed" && order.completedAt !== null
      && order.completedAt.getTime() + COMMISSION_FILE_POLICY.completedRetentionMs <= at.getTime();
    if (!closedUnpaidDue && !completedDue) continue;
    if (await input.holds.hasEvidenceHold(input.db, file.orderId!)) continue;
    retentionDue += 1;
    if (input.retentionMode !== "enforce") continue;
    const [deleted] = await input.db.update(commissionFiles).set({ state: "deleted", endedAt: at, ...bump })
      .where(and(eq(commissionFiles.id, file.id), eq(commissionFiles.state, "attached"))).returning({ id: commissionFiles.id });
    if (deleted) retentionDeleted += 1;
  }
  const retentionNextAfter: CommissionFileRetentionCursor | null = attached.length === input.batchSize
    ? { attachedAt: attached[attached.length - 1]!.attachedAt!, id: attached[attached.length - 1]!.id }
    : null;

  const [backlog] = await input.db.select({ total: count(), oldest: min(commissionFiles.uploadedAt) }).from(commissionFiles).where(eq(commissionFiles.state, "scanning"));
  const oldest = backlog?.oldest ?? null;
  return {
    expired: expired.length, discarded: discarded.length, scanFailed: scanFailed.length, recovered: recovered.length, enqueued: toEnqueue.length,
    purged, purgeFailures, purgeNextAfter, retentionDue, retentionDeleted, retentionNextAfter, scanning: Number(backlog?.total ?? 0),
    oldestScanningSeconds: oldest ? Math.max(0, Math.floor((at.getTime() - oldest.getTime()) / 1000)) : null,
  };
}
