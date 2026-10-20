import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import { metricsRegistry } from "@pawket/observability";
import type { NotificationMaintenanceFailure } from "@pawket/notifications";
import { createWorkerHealthState, workerReadiness } from "../src/worker-health.js";
import { startWorker, type WorkerRuntimeDependencies } from "../src/worker-runtime.js";

afterEach(() => vi.useRealTimers());
const result = { digestsQueued: 1, digestsDeferred: 0, digestsSuppressed: 0, digestsFailed: 0, remindersCreated: 3, remindersFailed: 0, deleted: 2 };
const revision = { revision: "a".repeat(40), buildRevision: "a".repeat(40), revisionMatch: true } as const;
async function runtime(mode: "disabled" | "enabled" = "enabled") {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-12T00:00:00Z"));
  const maintenance = { runOnce: vi.fn().mockResolvedValue(result) };
  let reportFailure!: (failure: NotificationMaintenanceFailure) => void;
  const createMaintenance = vi.fn((_db: unknown, onFailure: typeof reportFailure) => { reportFailure = onFailure; return maintenance; });
  const state = createWorkerHealthState(); const createMaterializer = vi.fn(() => ({ materialize: vi.fn() }));
  const resource = { connect: async () => undefined, quit: async () => undefined, close: vi.fn(async () => undefined), disconnect: async () => undefined };
  const logger = { info: vi.fn(), error: vi.fn() };
  const dispatch = vi.fn().mockResolvedValue({ claimed: 0, enqueued: 0, failed: 0 });
  const handle = await startWorker({ databaseUrl: "unused", valkeyUrl: "unused", concurrency: 1, batchSize: 2, leaseMs: 30_000,
    signalSource: new EventEmitter(), logger, healthState: state, notifications: { mode, createMaterializer, createMaintenance },
    dependencies: { createDatabase: () => ({ db: {}, close: resource.close }), createProducerConnection: () => resource,
      createWorkerConnection: () => resource, createQueue: () => resource, createWorker: () => resource, dispatch,
      scanRefundWindows: async () => ({}), readBacklogMetrics: async () => ({}), hostname: () => "synthetic", randomUUID,
    } as unknown as Partial<WorkerRuntimeDependencies> });
  await vi.advanceTimersByTimeAsync(0);
  return { maintenance, createMaintenance, handle, logger, dispatch, resource, state, reportFailure: (failure: NotificationMaintenanceFailure) => reportFailure(failure) };
}
// The synthetic runtime also logs its stubbed refund and backlog reads; only this scan's category matters here.
const maintenanceErrors = (logger: { error: ReturnType<typeof vi.fn> }) =>
  logger.error.mock.calls.filter(([fields]) => (fields as { category?: string }).category === "notification_maintenance_failed");

test("enabled maintenance runs every 60 seconds", async () => {
  const r = await runtime();
  try {
    expect(r.createMaintenance).toHaveBeenCalledOnce(); expect(r.maintenance.runOnce).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(59_000); expect(r.maintenance.runOnce).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000); expect(r.maintenance.runOnce).toHaveBeenCalledTimes(2);
    expect(maintenanceErrors(r.logger)).toEqual([]);
  } finally { await r.handle.stop(); }
});

test("disabled notifications never build or run maintenance", async () => {
  const r = await runtime("disabled");
  try {
    await vi.advanceTimersByTimeAsync(120_000);
    expect(r.createMaintenance).not.toHaveBeenCalled(); expect(r.maintenance.runOnce).not.toHaveBeenCalled();
  } finally { await r.handle.stop(); }
});

test("a failure is logged by category only and never stops outbox polling", async () => {
  const r = await runtime();
  try {
    r.maintenance.runOnce.mockRejectedValue(new Error("private message text"));
    const polls = r.dispatch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.logger.error).toHaveBeenCalledWith({ category: "notification_maintenance_failed" }, "Notification maintenance failed");
    expect(JSON.stringify(r.logger.error.mock.calls)).not.toContain("private message");
    expect(r.dispatch.mock.calls.length).toBeGreaterThan(polls + 50);
    expect(maintenanceErrors(r.logger)).toEqual([[{ category: "notification_maintenance_failed" }, "Notification maintenance failed"]]);
    r.maintenance.runOnce.mockResolvedValue(result); await vi.advanceTimersByTimeAsync(60_000);
    expect(r.maintenance.runOnce).toHaveBeenCalledTimes(3);
  } finally { await r.handle.stop(); }
});

test.each([{}, { ...result, deleted: -1 }, { ...result, digestsQueued: 0.5 }, { ...result, remindersCreated: 100_001 }, { ...result, remindersFailed: -1 },
  { digestsQueued: 1, digestsDeferred: 0, remindersCreated: 0, deleted: 2 }])("an invalid result is treated as a failure", async (invalid) => {
  const r = await runtime();
  try {
    r.maintenance.runOnce.mockResolvedValueOnce(invalid); await vi.advanceTimersByTimeAsync(60_000);
    expect(r.logger.error).toHaveBeenCalledWith({ category: "notification_maintenance_failed" }, "Notification maintenance failed");
  } finally { await r.handle.stop(); }
});

test("maintenance does not overlap or block polling and shutdown drains it", async () => {
  const r = await runtime(); const pending = Promise.withResolvers<typeof result>();
  try {
    r.maintenance.runOnce.mockReturnValueOnce(pending.promise); await vi.advanceTimersByTimeAsync(180_000);
    expect(r.maintenance.runOnce).toHaveBeenCalledTimes(2); expect(r.dispatch.mock.calls.length).toBeGreaterThanOrEqual(180);
    let stopped = false; const stopping = r.handle.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(1_000); expect(stopped).toBe(false); expect(r.resource.close).not.toHaveBeenCalled();
    pending.resolve(result); await stopping;
  } finally { pending.resolve(result); await r.handle.stop(); }
});

test("a notification configuration without a maintenance factory is refused", async () => {
  await expect(startWorker({ databaseUrl: "unused", valkeyUrl: "unused", concurrency: 1, batchSize: 2, leaseMs: 30_000,
    notifications: { mode: "enabled", createMaterializer: () => ({ materialize: vi.fn() }) } as never })).rejects.toThrow("Invalid notification worker configuration");
});

test("notificationScan is up after a full run and publishes scan metrics", async () => {
  const r = await runtime();
  try {
    expect(r.state).toMatchObject({ notificationScanConfigured: true, notificationScanMaximumAgeMs: 180_000, lastNotificationScanSucceededAt: Date.now() });
    expect(workerReadiness({ state: r.state, revision })).toMatchObject({ notificationScan: "up" });
    const metrics = await metricsRegistry.metrics();
    expect(metrics).toContain('pawket_worker_scan_healthy{scan="notification"} 1');
    expect(metrics).toContain(`pawket_worker_last_success_timestamp_seconds{scan="notification"} ${Date.now() / 1_000}`);
  } finally { await r.handle.stop(); }
});

test("disabled notifications report notificationScan not_configured", async () => {
  const r = await runtime("disabled");
  try {
    expect(r.state.notificationScanConfigured).toBe(false);
    expect(workerReadiness({ state: r.state, revision })).toMatchObject({ notificationScan: "not_configured" });
  } finally { await r.handle.stop(); }
});

test("a failed digest item or reminder candidate is logged by id only and does not renew the scan", async () => {
  const r = await runtime(); const subjectId = randomUUID(); const notificationId = randomUUID();
  try {
    const lastSuccess = r.state.lastNotificationScanSucceededAt;
    r.maintenance.runOnce.mockImplementation(async () => {
      r.reportFailure({ step: "reminder", clock: "delivery_due", subjectId });
      r.reportFailure({ step: "digest", notificationId });
      return { ...result, digestsFailed: 1, remindersFailed: 1 };
    });
    await vi.advanceTimersByTimeAsync(181_000);
    expect(r.logger.error).toHaveBeenCalledWith({ category: "notification_reminder_failed", clock: "delivery_due", subjectId }, "Notification reminder failed");
    expect(r.logger.error).toHaveBeenCalledWith({ category: "notification_digest_failed", notificationId }, "Notification digest failed");
    expect(r.state.lastNotificationScanSucceededAt).toBe(lastSuccess);
    expect(workerReadiness({ state: r.state, revision })).toMatchObject({ notificationScan: "down" });
    expect(await metricsRegistry.metrics()).toContain('pawket_worker_scan_healthy{scan="notification"} 0');
    r.maintenance.runOnce.mockResolvedValue(result); await vi.advanceTimersByTimeAsync(60_000);
    expect(workerReadiness({ state: r.state, revision })).toMatchObject({ notificationScan: "up" });
  } finally { await r.handle.stop(); }
});

test("a thrown run keeps the last success and turns the scan down after 180 seconds", async () => {
  const r = await runtime();
  try {
    const lastSuccess = r.state.lastNotificationScanSucceededAt;
    r.maintenance.runOnce.mockRejectedValue(new Error("private message text"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(workerReadiness({ state: r.state, revision })).toMatchObject({ notificationScan: "up" });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(r.state.lastNotificationScanSucceededAt).toBe(lastSuccess);
    expect(workerReadiness({ state: r.state, revision })).toMatchObject({ notificationScan: "down" });
  } finally { await r.handle.stop(); }
});
