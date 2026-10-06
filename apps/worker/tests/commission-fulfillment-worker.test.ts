import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import { metricsRegistry } from "@pawket/observability";
import { createWorkerCommissionConfiguration } from "../src/commission-config.js";
import { startWorker, type WorkerRuntimeDependencies } from "../src/worker-runtime.js";
import { createWorkerHealthState, workerReadiness } from "../src/worker-health.js";

afterEach(() => vi.useRealTimers());
const report = { requested: 0, quoted: 0, awaitingPayment: 0, inProgress: 0, delivered: 0, completed: 0,
  completedBuyer: 0, completedAutomatic: 0, completionBacklog: 0, lateDeliveries: 0, draftSubmissions: 0, finalSubmissions: 0,
  expiredRequests: 0, expiredQuotes: 0, expiredPayments: 0, oldestExpiryLagSeconds: 0, overdue: 0, retentionUnacceptedClosed: 0, retentionAccepted: 0 };
async function runtime(mode: "disabled" | "enabled") {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-06T00:00:00Z"));
  const service = { expireDue: vi.fn().mockResolvedValue({ scanned: 0, expired: 0 }),
    recoverInvalidations: vi.fn().mockResolvedValue({ scanned: 0, invalidated: 0, deferred: 0, nextAfterId: null }),
    readOperationalReport: vi.fn().mockResolvedValue(report),
    observeFulfillmentMode: vi.fn().mockResolvedValue({ change: "none", paused: mode === "disabled" }),
    completeDue: vi.fn().mockResolvedValue({ scanned: 0, completed: 0, held: 0, waiting: 0, nextAfter: null }) };
  const resource = { connect: async () => undefined, quit: async () => undefined, close: vi.fn(async () => undefined), disconnect: async () => undefined };
  const dispatch = vi.fn().mockResolvedValue({ claimed: 0, enqueued: 0, failed: 0 });
  const logger = { info: vi.fn(), error: vi.fn() }; const state = createWorkerHealthState();
  const handle = await startWorker({ databaseUrl: "unused", valkeyUrl: "unused", concurrency: 1, batchSize: 2, leaseMs: 30_000,
    signalSource: new EventEmitter(), logger, healthState: state,
    commissions: { fulfillmentMode: mode, batchSize: 2, scanIntervalMs: 5_000, createService: () => service as never },
    dependencies: { createDatabase: () => ({ db: {}, close: resource.close }), createProducerConnection: () => resource,
      createWorkerConnection: () => resource, createQueue: () => resource, createWorker: () => resource, dispatch,
      scanRefundWindows: async () => ({}), readBacklogMetrics: async () => ({}), hostname: () => "synthetic", randomUUID,
    } as unknown as Partial<WorkerRuntimeDependencies> });
  await vi.advanceTimersByTimeAsync(0);
  return { service, handle, logger, state, dispatch, resource };
}

test("worker configuration forwards the fulfillment switch", () => {
  const config = createWorkerCommissionConfiguration({ APP_REVISION: "synthetic", PII_LOOKUP_HMAC_KEY: "", COMMISSION_PAYMENTS_MODE: "disabled",
    COMMISSION_FULFILLMENT_MODE: "enabled", COMMISSION_SCAN_BATCH_SIZE: 2, COMMISSION_SCAN_INTERVAL_MS: 5_000 }, {} as never, {} as never);
  expect(config).toMatchObject({ fulfillmentMode: "enabled" });
});
test("disabled fulfillment observes the pause every tick without completing orders", async () => {
  const r = await runtime("disabled");
  try {
    await vi.advanceTimersByTimeAsync(5_000);
    expect(r.service.observeFulfillmentMode.mock.calls).toEqual([["disabled"], ["disabled"]]);
    expect(r.service.completeDue).not.toHaveBeenCalled();
    expect(await metricsRegistry.metrics()).toContain("pawket_commission_fulfillment_paused 1");
    expect(await metricsRegistry.metrics()).toContain('pawket_worker_scan_healthy{scan="commission_fulfillment"} 1');
  } finally { await r.handle.stop(); }
});
test("enabled fulfillment observes before completing and advances then resets the cursor", async () => {
  const r = await runtime("enabled"); const cursor = { reviewEndsAt: new Date("2026-10-05T00:00Z"), id: randomUUID() };
  try {
    r.service.completeDue.mockResolvedValueOnce({ scanned: 2, completed: 1, held: 1, waiting: 0, nextAfter: cursor });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(r.service.completeDue.mock.calls.map(([command]) => command)).toEqual([
      { limit: 2, after: null }, { limit: 2, after: null }, { limit: 2, after: cursor }, { limit: 2, after: null }]);
    expect(r.service.observeFulfillmentMode.mock.invocationCallOrder[0]).toBeLessThan(r.service.completeDue.mock.invocationCallOrder[0]!);
    expect(r.state).toMatchObject({ commissionFulfillmentConfigured: true, lastCommissionFulfillmentSucceededAt: Date.now() });
    expect(await metricsRegistry.metrics()).toContain("pawket_commission_fulfillment_configured 1");
    expect(await metricsRegistry.metrics()).toContain("pawket_commission_fulfillment_paused 0");
  } finally { await r.handle.stop(); }
});
test.each(["observeFulfillmentMode", "completeDue"] as const)("%s failure marks scan unhealthy and emits only a fixed category", async (method) => {
  const r = await runtime("enabled");
  try {
    r.logger.error.mockClear(); r.service[method].mockRejectedValueOnce(new Error(`private-order:${randomUUID()}`));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await metricsRegistry.metrics()).toContain('pawket_worker_scan_healthy{scan="commission_fulfillment"} 0');
    const errors = r.logger.error.mock.calls.filter(([data]) => data.category === "commission_fulfillment_failed");
    expect(errors).toEqual([[{ category: "commission_fulfillment_failed" }, "Commission fulfillment failed"]]);
    expect(JSON.stringify(r.logger.error.mock.calls)).not.toContain("private-order:");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await metricsRegistry.metrics()).toContain('pawket_worker_scan_healthy{scan="commission_fulfillment"} 1');
  } finally { await r.handle.stop(); }
});
test("fulfillment does not overlap or block polling and shutdown drains its current scan", async () => {
  const r = await runtime("enabled"); let resolve!: (value: unknown) => void;
  const pending = new Promise((done) => { resolve = done; });
  try {
    r.service.completeDue.mockReturnValueOnce(pending);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(r.service.completeDue).toHaveBeenCalledTimes(2);
    expect(r.dispatch.mock.calls.length).toBeGreaterThanOrEqual(15);
    let stopped = false; const stopping = r.handle.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(1_000); expect(stopped).toBe(false); expect(r.resource.close).not.toHaveBeenCalled();
    resolve({ scanned: 0, completed: 0, held: 0, waiting: 0, nextAfter: null }); await stopping;
    expect(r.resource.close).toHaveBeenCalled();
  } finally { resolve({ scanned: 0, completed: 0, held: 0, waiting: 0, nextAfter: null }); await r.handle.stop(); }
});
test("readiness includes configured fulfillment observation even while paused", () => {
  const state = createWorkerHealthState(); const now = Date.now();
  Object.assign(state, { initializedAt: now, lastPollSucceededAt: now, lastRefundScanSucceededAt: now,
    publicMediaCleanupConfigured: true, lastPublicMediaCleanupScanSucceededAt: now,
    commissionFulfillmentConfigured: true, commissionFulfillmentMaximumAgeMs: 15_000, lastCommissionFulfillmentSucceededAt: now - 16_000 });
  const revision = { revision: "a".repeat(40), buildRevision: "a".repeat(40), revisionMatch: true } as const;
  expect(workerReadiness({ state, revision, now })).toMatchObject({ status: "not_ready", commissionFulfillmentScan: "down" });
  Object.assign(state, { lastCommissionFulfillmentSucceededAt: now });
  expect(workerReadiness({ state, revision, now })).toMatchObject({ status: "ready", commissionFulfillmentScan: "up" });
});
