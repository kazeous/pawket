import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import { metricsRegistry, recordResolutionOperation, setCommissionRefundOverdueMetric } from "@pawket/observability";
import { startWorker, type WorkerRuntimeDependencies } from "../src/worker-runtime.js";
import { createWorkerHealthState, workerReadiness } from "../src/worker-health.js";

afterEach(() => vi.useRealTimers());
const result = { expiredProposals: 0, lapsedProposals: 0, escalatedClaims: 0, overdueCases: 0, presumedReceived: 0, purgedDestinations: 0 };
async function runtime(mode: "disabled" | "enabled", configured = true) {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-08T00:00:00Z"));
  const service = { observeResolutionMode: vi.fn().mockResolvedValue({ change: "none", paused: mode === "disabled" }), scan: vi.fn().mockResolvedValue(result), readRefundOverdueCount: vi.fn().mockResolvedValue(2) };
  const resource = { connect: async () => undefined, quit: async () => undefined, close: vi.fn(async () => undefined), disconnect: async () => undefined };
  const commission = { expireDue: async () => ({ scanned: 0, expired: 0 }), recoverInvalidations: async () => ({ scanned: 0, invalidated: 0, deferred: 0, nextAfterId: null }),
    readOperationalReport: async () => ({}), observeFulfillmentMode: async () => ({ change: "none", paused: true }) };
  const state = createWorkerHealthState(); const logger = { info: vi.fn(), error: vi.fn() }; const dispatch = vi.fn().mockResolvedValue({ claimed: 0, enqueued: 0, failed: 0 });
  const handle = await startWorker({ databaseUrl: "unused", valkeyUrl: "unused", concurrency: 1, batchSize: 2, leaseMs: 30_000,
    signalSource: new EventEmitter(), logger, healthState: state,
    ...(configured ? { commissions: { fulfillmentMode: "disabled" as const, batchSize: 2, scanIntervalMs: 5_000, createService: () => commission as never,
      resolution: { mode, createService: () => service } } } : {}),
    dependencies: { createDatabase: () => ({ db: {}, close: resource.close }), createProducerConnection: () => resource,
      createWorkerConnection: () => resource, createQueue: () => resource, createWorker: () => resource, dispatch,
      scanRefundWindows: async () => ({}), readBacklogMetrics: async () => ({}), hostname: () => "synthetic", randomUUID,
    } as unknown as Partial<WorkerRuntimeDependencies> });
  await vi.advanceTimersByTimeAsync(0); return { service, state, handle, logger, dispatch, resource };
}
const revision = { revision: "a".repeat(40), buildRevision: "a".repeat(40), revisionMatch: true } as const;
test("the scan is not_configured without a commission configuration and up after a successful run", async () => {
  const absent = await runtime("enabled", false);
  try { expect(workerReadiness({ state: absent.state, revision })).toMatchObject({ commissionResolutionScan: "not_configured" }); expect(absent.service.scan).not.toHaveBeenCalled(); }
  finally { await absent.handle.stop(); }
  const r = await runtime("enabled");
  try {
    expect(r.state).toMatchObject({ commissionResolutionConfigured: true, commissionResolutionMaximumAgeMs: 15_000, lastCommissionResolutionSucceededAt: Date.now() });
    expect(workerReadiness({ state: r.state, revision })).toMatchObject({ commissionResolutionScan: "up" });
    expect(r.service.scan).toHaveBeenCalledWith({ limit: 2 });
    expect(await metricsRegistry.metrics()).toContain("pawket_commission_refund_overdue 2");
    expect(r.service.observeResolutionMode.mock.invocationCallOrder[0]).toBeLessThan(r.service.scan.mock.invocationCallOrder[0]!);
    expect(await metricsRegistry.metrics()).toContain('pawket_worker_scan_healthy{scan="commission_resolution"} 1');
  } finally { await r.handle.stop(); }
});
test("disabled resolution observes mode every run without transitions", async () => {
  const r = await runtime("disabled");
  try { await vi.advanceTimersByTimeAsync(5_000); expect(r.service.observeResolutionMode.mock.calls).toEqual([["disabled"], ["disabled"]]);
    expect(r.service.scan).not.toHaveBeenCalled(); expect(await metricsRegistry.metrics()).toContain("pawket_commission_resolution_paused 1");
  } finally { await r.handle.stop(); }
});
test.each([{}, { ...result, overdueCases: -1 }, { ...result, presumedReceived: 3 }, { ...result, expiredProposals: 0.5 }])("an invalid scan result marks it unhealthy", async (invalid) => {
  const r = await runtime("enabled");
  try { r.service.scan.mockResolvedValueOnce(invalid); await vi.advanceTimersByTimeAsync(5_000);
    expect(await metricsRegistry.metrics()).toContain('pawket_worker_scan_healthy{scan="commission_resolution"} 0');
    expect(r.state.lastCommissionResolutionSucceededAt).toBeNull();
    expect(workerReadiness({ state: r.state, revision })).toMatchObject({ status: "not_ready", commissionResolutionScan: "down" });
  } finally { await r.handle.stop(); }
});
test.each(["observeResolutionMode", "scan"] as const)("%s failure logs only a fixed category and recovers", async (method) => {
  const r = await runtime("enabled");
  try { r.logger.error.mockClear(); r.service[method].mockRejectedValueOnce(new Error("private-content")); await vi.advanceTimersByTimeAsync(5_000);
    expect(r.logger.error.mock.calls.filter(([data]) => data.category === "commission_resolution_failed")).toEqual([[{ category: "commission_resolution_failed" }, "Commission resolution failed"]]);
    expect(JSON.stringify(r.logger.error.mock.calls)).not.toContain("private-content");
    await vi.advanceTimersByTimeAsync(5_000); expect(workerReadiness({ state: r.state, revision })).toMatchObject({ commissionResolutionScan: "up" });
  } finally { await r.handle.stop(); }
});
test("resolution scan does not overlap or block polling and shutdown drains it", async () => {
  const r = await runtime("enabled"); let resolve!: (value: unknown) => void; const pending = new Promise((done) => { resolve = done; });
  try { r.service.scan.mockReturnValueOnce(pending); await vi.advanceTimersByTimeAsync(15_000); expect(r.service.scan).toHaveBeenCalledTimes(2);
    expect(r.dispatch.mock.calls.length).toBeGreaterThanOrEqual(15); let stopped = false; const stopping = r.handle.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(1_000); expect(stopped).toBe(false); expect(r.resource.close).not.toHaveBeenCalled(); resolve(result); await stopping;
  } finally { resolve(result); await r.handle.stop(); }
});
test("resolution observability rejects unbounded labels and invalid overdue counts", () => {
  expect(() => recordResolutionOperation({ operation: "private-content", outcome: "completed" })).toThrow();
  expect(() => recordResolutionOperation({ operation: "scan", outcome: "private-content" })).toThrow();
  expect(() => setCommissionRefundOverdueMetric(-1)).toThrow();
});
