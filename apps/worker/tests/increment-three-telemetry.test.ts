import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { metricsRegistry } from "@pawket/observability";
import { MEDIA_PROCESS_JOB } from "@pawket/queue";

import {
  createMediaJobProcessor,
  startWorker,
  type WorkerRuntimeDependencies,
} from "../src/worker-runtime.js";

const logger = { info: vi.fn(), error: vi.fn() };

function runtimeDependencies(backlog: Awaited<ReturnType<WorkerRuntimeDependencies["readBacklogMetrics"]>>) {
  const resource = { close: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined) };
  return {
    createDatabase: () => ({ db: {}, close: vi.fn(async () => undefined) }),
    createProducerConnection: () => ({
      connect: vi.fn(async () => undefined),
      quit: vi.fn(async () => undefined),
      disconnect: vi.fn(),
    }),
    createWorkerConnection: () => ({
      connect: vi.fn(async () => undefined),
      quit: vi.fn(async () => undefined),
      disconnect: vi.fn(),
    }),
    createQueue: () => resource,
    createMediaQueue: () => resource,
    createWorker: () => resource,
    createMediaWorker: () => resource,
    dispatch: vi.fn(async () => ({ claimed: 0, enqueued: 0, failed: 0 })),
    acknowledge: vi.fn(async () => true),
    processMediaAsset: vi.fn(),
    scanRefundWindows: vi.fn(async () => ({
      dueSoon: 0,
      dueToday: 0,
      overdue: 0,
      attention: 0,
      outstandingAmountVnd: 0,
    })),
    readBacklogMetrics: vi.fn(async () => backlog),
    runRetention: vi.fn(async () => []),
    runMediaCleanup: vi.fn(),
    hostname: () => "telemetry-worker",
    randomUUID,
  } as unknown as WorkerRuntimeDependencies;
}

describe("Increment 3 worker telemetry wiring", () => {
  beforeEach(() => {
    metricsRegistry.resetMetrics();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test.each([
    ["ready", "succeeded"],
    ["failed", "attention_required"],
    ["ignored", "rejected"],
  ] as const)("records the bounded %s media processing result", async (state, outcome) => {
    const assetId = randomUUID();
    const processor = createMediaJobProcessor({
      logger,
      database: {} as never,
      storage: {} as never,
      workerId: "runtime-worker:media-metric",
      processAsset: vi.fn(async () => ({
        assetId,
        state,
        ...(state === "failed" ? { failureCode: "malformed_image" } : {}),
      })),
    });

    await processor({ id: assetId, name: MEDIA_PROCESS_JOB, data: { assetId } } as never);

    expect(await metricsRegistry.metrics()).toContain(
      `pawket_public_media_operations_total{operation="process",outcome="${outcome}",purpose="none",variant="none"} 1`,
    );
  });

  test("publishes media and report backlog gauges from the operational query", async () => {
    vi.useFakeTimers();
    const dependencies = runtimeDependencies({
      outbox: { pending: 0, oldestAgeSeconds: 0 },
      email: { pending: 0, oldestAgeSeconds: 0, attention: 0 },
      publicMedia: { oldestPendingSeconds: 901 },
      publicContentReports: { oldestOpenSeconds: 21_601 },
    } as never);
    const handle = await startWorker({
      databaseUrl: "postgresql://unused:unused@127.0.0.1:5432/unused",
      valkeyUrl: "redis://127.0.0.1:6379/15",
      concurrency: 1,
      batchSize: 10,
      leaseMs: 30_000,
      signalSource: new EventEmitter(),
      dependencies,
    });

    await vi.advanceTimersByTimeAsync(0);

    const metrics = await metricsRegistry.metrics();
    expect(metrics).toContain("pawket_public_media_oldest_pending_seconds 901");
    expect(metrics).toContain("pawket_public_content_report_oldest_open_seconds 21601");
    await handle.stop();
  });

  test("publishes a revision-bound worker heartbeat after a successful cleanup scan", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T00:00:00.000Z"));
    const publishHealth = vi.fn(async () => undefined);
    const dependencies = runtimeDependencies({
      outbox: { pending: 0, oldestAgeSeconds: 0 },
      email: { pending: 0, oldestAgeSeconds: 0, attention: 0 },
      publicMedia: { oldestPendingSeconds: 0 },
      publicContentReports: { oldestOpenSeconds: 0 },
    });
    dependencies.runMediaCleanup = vi.fn(async () => ({
      results: [],
      counts: {
        processed_source: { candidate: 0, protected: 0, processed: 0, failed: 0 },
        failed_quarantine: { candidate: 0, protected: 0, processed: 0, failed: 0 },
        ready_unreferenced: { candidate: 0, protected: 0, processed: 0, failed: 0 },
        superseded_derivative: { candidate: 0, protected: 0, processed: 0, failed: 0 },
      },
      candidateCount: 0,
      protectedCount: 0,
      processedCount: 0,
      failedCount: 0,
      oldestEligibleAt: null,
    }));
    Object.assign(dependencies, { writePublicMediaWorkerHealth: publishHealth });
    const handle = await startWorker({
      databaseUrl: "postgresql://unused:unused@127.0.0.1:5432/unused",
      valkeyUrl: "redis://127.0.0.1:6379/15",
      revision: "9f6ac0e1b2d34567890abcdef1234567890abcde",
      concurrency: 1,
      batchSize: 10,
      leaseMs: 30_000,
      signalSource: new EventEmitter(),
      dependencies,
      publicMediaCleanup: {
        mode: "report_only",
        retentionMode: "report_only",
        globalPause: true,
        batchSize: 25,
        scanIntervalMs: 21_600_000,
      },
    } as never);

    await vi.advanceTimersByTimeAsync(0);

    expect(publishHealth).toHaveBeenCalledWith(
      expect.anything(),
      {
        revision: "9f6ac0e1b2d34567890abcdef1234567890abcde",
        scanSucceededAtMs: Date.now(),
      },
    );
    const scanSucceededAtMs = Date.now();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(publishHealth).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(publishHealth).toHaveBeenCalledTimes(2);
    expect(publishHealth).toHaveBeenLastCalledWith(
      expect.anything(),
      {
        revision: "9f6ac0e1b2d34567890abcdef1234567890abcde",
        scanSucceededAtMs,
      },
    );
    await handle.stop();
  });
});
