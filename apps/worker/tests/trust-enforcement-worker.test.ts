import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import { metricsRegistry } from "@pawket/observability";
import { startWorker, type WorkerRuntimeDependencies } from "../src/worker-runtime.js";
import { createWorkerHealthState, workerReadiness } from "../src/worker-health.js";

afterEach(() => vi.useRealTimers());
const result = { expired: 1, purgedSessions: 2, purgedRequests: 3 };
const revision = { revision: "a".repeat(40), buildRevision: "a".repeat(40), revisionMatch: true } as const;
async function runtime(mode: "disabled" | "enabled" = "disabled", configured = true) {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-12T00:00:00Z"));
  const service = { runOnce: vi.fn().mockResolvedValue(result) };
  let reportFailure!: (penaltyId: string) => void;
  const createService = vi.fn((_db: unknown, onPenaltyFailure: typeof reportFailure) => { reportFailure = onPenaltyFailure; return service; });
  const resource = { connect: async () => undefined, quit: async () => undefined, close: vi.fn(async () => undefined), disconnect: async () => undefined };
  const state = createWorkerHealthState(); const logger = { info: vi.fn(), error: vi.fn() };
  const dispatch = vi.fn().mockResolvedValue({ claimed: 0, enqueued: 0, failed: 0 });
  const handle = await startWorker({ databaseUrl: "unused", valkeyUrl: "unused", concurrency: 1, batchSize: 2, leaseMs: 30_000,
    signalSource: new EventEmitter(), logger, healthState: state, ...(configured ? { trustEnforcement: { mode, createService } } : {}),
    dependencies: { createDatabase: () => ({ db: {}, close: resource.close }), createProducerConnection: () => resource,
      createWorkerConnection: () => resource, createQueue: () => resource, createWorker: () => resource, dispatch,
      scanRefundWindows: async () => ({}), readBacklogMetrics: async () => ({}), hostname: () => "synthetic", randomUUID,
    } as unknown as Partial<WorkerRuntimeDependencies> });
  await vi.advanceTimersByTimeAsync(0);
  return { service, createService, state, handle, logger, dispatch, resource, reportFailure };
}

test.each(["disabled", "enabled"] as const)("%s enforcement scans every 60 seconds and publishes readiness and metrics", async (mode) => {
  const r = await runtime(mode);
  try {
    expect(r.createService).toHaveBeenCalledOnce(); expect(r.service.runOnce).toHaveBeenCalledOnce();
    expect(r.state).toMatchObject({ trustEnforcementConfigured: true, trustEnforcementMaximumAgeMs: 180_000, lastTrustEnforcementSucceededAt: Date.now() });
    expect(workerReadiness({ state: r.state, revision })).toMatchObject({ trustEnforcementScan: "up" });
    await vi.advanceTimersByTimeAsync(59_000); expect(r.service.runOnce).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000); expect(r.service.runOnce).toHaveBeenCalledTimes(2);
    expect(await metricsRegistry.metrics()).toContain('pawket_worker_scan_healthy{scan="trust_enforcement"} 1');
    expect(await metricsRegistry.metrics()).toContain(`pawket_worker_last_success_timestamp_seconds{scan="trust_enforcement"} ${Date.now() / 1_000}`);
  } finally { await r.handle.stop(); }
});

test("a configured database with missing scan wiring is down, never not_configured", async () => {
  const r = await runtime("disabled", false);
  try {
    expect(r.service.runOnce).not.toHaveBeenCalled();
    expect(workerReadiness({ state: r.state, revision })).toMatchObject({ status: "not_ready", trustEnforcementScan: "down" });
  } finally { await r.handle.stop(); }
});

test("failure preserves the last success, logs no error contents, and recovers", async () => {
  const r = await runtime();
  try {
    const lastSuccess = r.state.lastTrustEnforcementSucceededAt;
    r.service.runOnce.mockRejectedValue(new Error("private token and explanation"));
    await vi.advanceTimersByTimeAsync(181_000);
    expect(r.state.lastTrustEnforcementSucceededAt).toBe(lastSuccess);
    expect(workerReadiness({ state: r.state, revision })).toMatchObject({ trustEnforcementScan: "down" });
    expect(await metricsRegistry.metrics()).toContain('pawket_worker_scan_healthy{scan="trust_enforcement"} 0');
    expect(r.logger.error).toHaveBeenCalledWith({ category: "trust_enforcement_failed" }, "Trust enforcement scan failed");
    expect(JSON.stringify(r.logger.error.mock.calls)).not.toContain("private token");
    r.service.runOnce.mockResolvedValue(result); await vi.advanceTimersByTimeAsync(59_000);
    expect(workerReadiness({ state: r.state, revision })).toMatchObject({ trustEnforcementScan: "up" });
  } finally { await r.handle.stop(); }
});

test("a partial batch failure is counted by ID and does not renew readiness", async () => {
  const r = await runtime(); const penaltyId = randomUUID();
  try {
    const lastSuccess = r.state.lastTrustEnforcementSucceededAt;
    r.service.runOnce.mockImplementationOnce(async () => { r.reportFailure(penaltyId); return result; });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.state.lastTrustEnforcementSucceededAt).toBe(lastSuccess);
    expect(r.logger.error).toHaveBeenCalledWith({ category: "trust_enforcement_penalty_failed", penaltyId }, "Trust penalty expiry failed");
    expect(r.logger.info).toHaveBeenCalledWith({ category: "trust_enforcement_completed", ...result, failedCount: 1 }, "Trust enforcement scan completed");
    expect(await metricsRegistry.metrics()).toContain('pawket_worker_scan_healthy{scan="trust_enforcement"} 0');
  } finally { await r.handle.stop(); }
});

test.each([{}, { ...result, expired: -1 }, { ...result, expired: 501 }, { ...result, purgedSessions: 0.5 }])("invalid counts do not renew readiness", async (invalid) => {
  const r = await runtime();
  try {
    const lastSuccess = r.state.lastTrustEnforcementSucceededAt;
    r.service.runOnce.mockResolvedValueOnce(invalid); await vi.advanceTimersByTimeAsync(60_000);
    expect(r.state.lastTrustEnforcementSucceededAt).toBe(lastSuccess);
    expect(await metricsRegistry.metrics()).toContain('pawket_worker_scan_healthy{scan="trust_enforcement"} 0');
  } finally { await r.handle.stop(); }
});

test("scan does not overlap or block polling and shutdown drains it", async () => {
  const r = await runtime(); const pending = Promise.withResolvers<typeof result>();
  try {
    r.service.runOnce.mockReturnValueOnce(pending.promise); await vi.advanceTimersByTimeAsync(180_000);
    expect(r.service.runOnce).toHaveBeenCalledTimes(2); expect(r.dispatch.mock.calls.length).toBeGreaterThanOrEqual(180);
    let stopped = false; const stopping = r.handle.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(1_000); expect(stopped).toBe(false); expect(r.resource.close).not.toHaveBeenCalled();
    pending.resolve(result); await stopping;
  } finally { pending.resolve(result); await r.handle.stop(); }
});
