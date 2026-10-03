import { randomUUID } from "node:crypto";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { describe, expect, test, vi } from "vitest";
import { COMMISSION_FILE_SCAN_JOB, OUTBOX_JOB, commissionFileScanJobId } from "@pawket/queue";
import { createWorkerCommissionFilesConfiguration } from "../src/commission-files-config.js";
import { createWorkerHealthState, workerReadiness } from "../src/worker-health.js";
import { createCommissionFileJobProcessor, createWorkerJobProcessor } from "../src/worker-runtime.js";

const revision = { revision: "a".repeat(40), buildRevision: "a".repeat(40), revisionMatch: true } as const;
const logger = { info: vi.fn(), error: vi.fn() };
const storageEnv = { COMMISSION_FILES_S3_ENDPOINT: "http://127.0.0.1:9090", COMMISSION_FILES_S3_REGION: "us-east-1", COMMISSION_FILES_S3_ACCESS_KEY_ID: "k",
  COMMISSION_FILES_S3_SECRET_ACCESS_KEY: "s", COMMISSION_FILES_QUARANTINE_BUCKET: "pawket-q", COMMISSION_FILES_CLEAN_BUCKET: "pawket-c", COMMISSION_FILES_S3_FORCE_PATH_STYLE: true };
const baseEnv = { COMMISSION_FILES_MODE: "disabled", COMMISSION_FILE_RETENTION_MODE: "report_only", COMMISSION_FILES_CLAMD_PORT: 3310, COMMISSION_FILES_SCAN_CONCURRENCY: 1,
  COMMISSION_FILES_SCAN_TIMEOUT_MS: 300_000, COMMISSION_FILES_MAINTENANCE_INTERVAL_MS: 60_000, COMMISSION_FILES_MAINTENANCE_BATCH_SIZE: 100 } as const;

function ready(state = createWorkerHealthState()) {
  const now = Date.now(); state.initializedAt = now; state.lastPollSucceededAt = now; state.lastRefundScanSucceededAt = now;
  state.publicMediaCleanupConfigured = true; state.lastPublicMediaCleanupScanSucceededAt = now; return state;
}

describe("commission file worker", () => {
  test("production configuration gives VERSION its own five-second bound", async () => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => { sockets.add(socket); socket.on("data", () => undefined); socket.on("close", () => sockets.delete(socket)); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const config = createWorkerCommissionFilesConfiguration({ ...baseEnv, ...storageEnv, COMMISSION_FILES_CLAMD_HOST: "127.0.0.1", COMMISSION_FILES_CLAMD_PORT: (server.address() as AddressInfo).port })!;
      expect(config.scannerProbe).not.toBe(config.scanner);
      const at = Date.now();
      await expect(config.scannerProbe.version()).rejects.toMatchObject({ reason: "timeout" });
      expect(Date.now() - at).toBeLessThan(8_000);
    } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  }, 10_000);
  test("configures only when storage and clamd exist, and refuses enabled mode without them", () => {
    expect(createWorkerCommissionFilesConfiguration({ ...baseEnv })).toBeUndefined();
    expect(() => createWorkerCommissionFilesConfiguration({ ...baseEnv, COMMISSION_FILES_MODE: "enabled", ...storageEnv })).toThrow("clamd");
    expect(createWorkerCommissionFilesConfiguration({ ...baseEnv, ...storageEnv, COMMISSION_FILES_CLAMD_HOST: "clamd" })).toMatchObject({ concurrency: 1, batchSize: 100, scanIntervalMs: 60_000, retentionMode: "report_only" });
  });
  test("keeps readiness independent of the scanner but not of the maintenance sweep", () => {
    const state = ready(); state.commissionFilesConfigured = true; state.commissionFilesMaximumAgeMs = 300_000; state.lastCommissionFilesMaintenanceSucceededAt = Date.now();
    state.commissionFileScanner = "down";
    expect(workerReadiness({ state, revision })).toMatchObject({ status: "ready", commissionFilesScan: "up", commissionFileScanner: "down" });
    state.lastCommissionFilesMaintenanceSucceededAt = Date.now() - 600_000;
    expect(workerReadiness({ state, revision })).toMatchObject({ status: "not_ready", commissionFilesScan: "down" });
    expect(workerReadiness({ state: ready(), revision })).toMatchObject({ status: "ready", commissionFilesScan: "not_configured", commissionFileScanner: "not_configured" });
  });
  test("routes an upload event to the scan queue as attempt 0", async () => {
    const fileId = randomUUID(); const add = vi.fn(async (_name: string, _data: unknown, options: { jobId?: string }) => ({ id: options.jobId }));
    const acknowledge = vi.fn(async () => true);
    const processor = createWorkerJobProcessor({ logger, database: {} as never, acknowledge, commissionFileQueue: { add } });
    const eventId = randomUUID();
    await processor({ id: eventId, name: OUTBOX_JOB, data: { outboxEventId: eventId, eventType: "commission.file_uploaded.v1", eventVersion: 1, aggregateType: "commission_file",
      aggregateId: fileId, payload: { fileId, correlationId: "req-1" }, occurredAt: new Date().toISOString() } } as never);
    expect(add).toHaveBeenCalledWith(COMMISSION_FILE_SCAN_JOB, { fileId, attempt: 0 }, expect.objectContaining({ jobId: commissionFileScanJobId(fileId, 0) }));
    expect(acknowledge).toHaveBeenCalled();
  });
  test("acknowledges scan results and rejects mismatched upload events", async () => {
    const acknowledge = vi.fn(async () => true); const add = vi.fn();
    const processor = createWorkerJobProcessor({ logger, database: {} as never, acknowledge, commissionFileQueue: { add } });
    const eventId = randomUUID(); const fileId = randomUUID();
    await processor({ id: eventId, name: OUTBOX_JOB, data: { outboxEventId: eventId, eventType: "commission.file_scanned.v1", eventVersion: 1, aggregateType: "commission_file",
      aggregateId: fileId, payload: { fileId, outcome: "clean" }, occurredAt: new Date().toISOString() } } as never);
    expect(acknowledge).toHaveBeenCalledTimes(1);
    const badId = randomUUID();
    await expect(processor({ id: badId, name: OUTBOX_JOB, data: { outboxEventId: badId, eventType: "commission.file_uploaded.v1", eventVersion: 1, aggregateType: "commission_file",
      aggregateId: randomUUID(), payload: { fileId, correlationId: "req-1" }, occurredAt: new Date().toISOString() } } as never)).rejects.toThrow();
    expect(add).not.toHaveBeenCalled();
  });
  test("scan jobs must match their attempt identity", async () => {
    const fileId = randomUUID(); const process = vi.fn(async () => ({ outcome: "clean" as const }));
    const processor = createCommissionFileJobProcessor({ logger, database: {} as never, storage: {} as never, scanner: {} as never, process });
    await processor({ id: commissionFileScanJobId(fileId, 2), name: COMMISSION_FILE_SCAN_JOB, data: { fileId, attempt: 2 } } as never);
    expect(process).toHaveBeenCalledWith(expect.objectContaining({ fileId }));
    await expect(processor({ id: "other", name: COMMISSION_FILE_SCAN_JOB, data: { fileId, attempt: 2 } } as never)).rejects.toThrow("Invalid commission file worker job");
  });
});
