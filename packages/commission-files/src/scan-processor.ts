import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { commissionFiles, insertOutboxEvent, type PawketDatabase } from "@pawket/database";

import { ClamdUnavailableError, type ClamdClient, type ClamdVerdict } from "./clamd-client.js";
import { COMMISSION_FILE_CONTENT_TYPES, COMMISSION_FILE_POLICY, commissionFileRetryDelayMs, commissionFileUuid, type CommissionFileContext } from "./file-policy.js";
import { classifyCommissionFile, createCommissionFileInspector } from "./file-signature.js";
import { CommissionFileStorageError, type CommissionFileStoragePort } from "./storage-port.js";

export type CommissionFileRejection = "malware" | "type_not_allowed" | "size_mismatch" | "encrypted_archive" | "limits_exceeded";
export type CommissionFileScanResult =
  | Readonly<{ outcome: "skipped" | "clean" | "scan_failed" }>
  | Readonly<{ outcome: "rejected"; reason: CommissionFileRejection }>
  | Readonly<{ outcome: "retry"; reason: "scanner_unavailable" | "signatures_stale" | "storage_unavailable" }>;
type Values = Partial<typeof commissionFiles.$inferInsert>;

export async function processCommissionFileScan(input: Readonly<{
  db: PawketDatabase; storage: CommissionFileStoragePort; scanner: Pick<ClamdClient, "scan" | "version">; fileId: string; now?: () => Date;
}>): Promise<CommissionFileScanResult> {
  if (!commissionFileUuid(input.fileId)) throw new Error("Invalid commission file ID");
  const now = input.now ?? (() => new Date());
  const claimedAt = now();
  const [file] = await input.db.update(commissionFiles).set({
    scanLeaseExpiresAt: new Date(claimedAt.getTime() + COMMISSION_FILE_POLICY.scanLeaseMs),
    version: sql`${commissionFiles.version} + 1`, updatedAt: sql`greatest(${commissionFiles.updatedAt}, ${claimedAt.toISOString()}::timestamptz)`,
  }).where(and(eq(commissionFiles.id, input.fileId), eq(commissionFiles.state, "scanning"),
    or(isNull(commissionFiles.nextScanAt), lte(commissionFiles.nextScanAt, claimedAt)),
    or(isNull(commissionFiles.scanLeaseExpiresAt), lte(commissionFiles.scanLeaseExpiresAt, claimedAt)))).returning();
  if (!file) return { outcome: "skipped" };
  const claimed = file;

  /** Applies the result only if no one else changed the row since the claim. */
  async function settle(values: Values, outcome?: "clean" | "rejected" | "scan_failed"): Promise<boolean> {
    return input.db.transaction(async (tx) => {
      const at = now();
      const [row] = await tx.update(commissionFiles).set({ ...values, scanLeaseExpiresAt: null, version: claimed.version + 1, updatedAt: at > claimed.updatedAt ? at : claimed.updatedAt })
        .where(and(eq(commissionFiles.id, claimed.id), eq(commissionFiles.version, claimed.version))).returning({ id: commissionFiles.id });
      if (!row) return false;
      if (outcome) await insertOutboxEvent(tx, { eventType: "commission.file_scanned.v1", eventVersion: 1, aggregateType: "commission_file", aggregateId: claimed.id,
        payload: { fileId: claimed.id, outcome }, occurredAt: at });
      return true;
    });
  }
  async function retry(reason: "scanner_unavailable" | "signatures_stale" | "storage_unavailable"): Promise<CommissionFileScanResult> {
    const attempts = claimed.scanAttempts + 1;
    return await settle({ scanAttempts: attempts, nextScanAt: new Date(now().getTime() + commissionFileRetryDelayMs(attempts)) }) ? { outcome: "retry", reason } : { outcome: "skipped" };
  }
  async function reject(reason: CommissionFileRejection, signature: string | null = null): Promise<CommissionFileScanResult> {
    return await settle({ state: "rejected", rejectionReason: reason, malwareSignature: reason === "malware" ? signature : null, nextScanAt: null, endedAt: now() }, "rejected")
      ? { outcome: "rejected", reason } : { outcome: "skipped" };
  }

  if (!claimed.scanDeadlineAt || claimedAt >= claimed.scanDeadlineAt) {
    return await settle({ state: "scan_failed", nextScanAt: null, endedAt: claimedAt }, "scan_failed") ? { outcome: "scan_failed" } : { outcome: "skipped" };
  }
  // A raw error from the storage SDK while streaming (connection drop, timeout, ...) must never
  // reach the caller unwrapped and must never be mistaken for a clean/clamd verdict. The real
  // clamd client re-wraps anything its source throws as its own ClamdUnavailableError, so the
  // outer catch below cannot tell "the scanner is down" from "the storage read broke" by error
  // type alone; `storageFailed` records the fact locally, from the only place that still knows
  // it, before the error is handed to the scanner. Only the read step (iterator.next()) is
  // covered — a bug in `inspector.update` below is a code defect, not a storage failure: under
  // the real client it still ends in a retry (re-wrapped as ClamdUnavailableError, i.e.
  // "scanner_unavailable"), but it is never misattributed to "storage_unavailable" and, with a
  // scanner that does not mask errors, it is free to propagate as the unhandled bug it is.
  let storageFailed = false;
  try {
    const engine = await input.scanner.version();
    if (claimedAt.getTime() - engine.signatureDate.getTime() > COMMISSION_FILE_POLICY.signatureMaxAgeMs) return await retry("signatures_stale");
    const head = await input.storage.head("quarantine", claimed.objectKey);
    if (!head || head.contentLength !== claimed.declaredBytes) return await reject("size_mismatch");
    const source = await input.storage.open("quarantine", claimed.objectKey, head.versionId);
    const sourceIterator = source[Symbol.asyncIterator]();
    // The opened body (an S3 SDK stream, in production) must be released on every exit path —
    // the scanner may never start reading it (e.g. a refused clamd connection), may abandon it
    // mid-stream (the real client's own `for await` closes its argument when a socket write
    // rejects), or we may abandon it ourselves on overflow. `for await` normally does this via
    // the iterator-close protocol, but that only works while `inspected()` keeps its own loop as
    // a `for await`; iterating `source` manually (needed so only the read step can set
    // `storageFailed`) opts out of that protocol, so release is made explicit and idempotent here
    // instead, called from every place the stream can stop being read.
    let sourceClosed = false;
    async function closeSource(): Promise<void> {
      if (sourceClosed) return;
      sourceClosed = true;
      try { await sourceIterator.return?.(); } catch { /* best-effort release; the scan outcome already reflects any failure */ }
    }
    const inspector = createCommissionFileInspector(); let overflow = false;
    async function* inspected(): AsyncIterable<Uint8Array> {
      let seen = 0;
      try {
        for (;;) {
          let result: IteratorResult<Uint8Array>;
          try {
            result = await sourceIterator.next();
          } catch (error) {
            storageFailed = true;
            throw error instanceof CommissionFileStorageError ? error : new CommissionFileStorageError("unavailable");
          }
          if (result.done) return;
          const chunk = result.value;
          seen += chunk.byteLength;
          if (seen > claimed.declaredBytes) { overflow = true; return; }
          inspector.update(chunk); yield chunk;
        }
      } finally {
        await closeSource();
      }
    }
    let verdict: ClamdVerdict;
    try {
      verdict = await input.scanner.scan(inspected());
    } finally {
      await closeSource();
    }
    const inspection = inspector.finish();
    if (overflow || inspection.bytes !== claimed.declaredBytes) return await reject("size_mismatch");
    if (verdict.kind === "found") return await reject(verdict.reason, verdict.signature);
    const classified = classifyCommissionFile(claimed.context as CommissionFileContext, inspection);
    if (classified.kind === "rejected") return await reject(classified.reason);
    // Always copy the exact scanned version; an earlier attempt's copy is never trusted for this scan's evidence.
    const copied = await input.storage.copyToClean({ key: claimed.objectKey, sourceVersionId: head.versionId, contentType: COMMISSION_FILE_CONTENT_TYPES[classified.type] });
    const verified = await input.storage.head("clean", claimed.objectKey);
    if (!verified || verified.contentLength !== claimed.declaredBytes || verified.versionId !== copied.versionId) return await retry("storage_unavailable");
    if (!await settle({ state: "clean", quarantineVersionId: head.versionId, cleanVersionId: copied.versionId, sha256: inspection.sha256,
      detectedType: classified.type, cleanAt: now(), nextScanAt: null }, "clean")) return { outcome: "skipped" };
    try {
      await input.storage.deleteAllVersions("quarantine", claimed.objectKey);
      const purgedAt = now();
      await input.db.update(commissionFiles).set({ quarantinePurgedAt: purgedAt, version: sql`${commissionFiles.version} + 1`, updatedAt: sql`greatest(${commissionFiles.updatedAt}, ${purgedAt.toISOString()}::timestamptz)` })
        .where(and(eq(commissionFiles.id, claimed.id), isNull(commissionFiles.quarantinePurgedAt)));
    } catch { /* Maintenance retries the quarantine purge; the clean state is already committed. */ }
    return { outcome: "clean" };
  } catch (error) {
    if (storageFailed || error instanceof CommissionFileStorageError) return await retry("storage_unavailable");
    if (error instanceof ClamdUnavailableError) return await retry("scanner_unavailable");
    throw error;
  }
}
