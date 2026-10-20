import { expect, test } from "vitest";
import { createWorkerHealthState, workerReadiness } from "../src/worker-health.js";

const revision = { revision: "a".repeat(40), buildRevision: "a".repeat(40), revisionMatch: true } as const;

test("trustEnforcementScan is not_configured without a database-backed scan", () => {
  expect(workerReadiness({ state: createWorkerHealthState(), revision, now: 1_000 })).toMatchObject({ trustEnforcementScan: "not_configured" });
});

test("trustEnforcementScan becomes down after 180 seconds without success", () => {
  const state = createWorkerHealthState();
  Object.assign(state, { initializedAt: 1_000, lastPollSucceededAt: 181_000, lastRefundScanSucceededAt: 181_000,
    publicMediaCleanupConfigured: true, lastPublicMediaCleanupScanSucceededAt: 181_000,
    trustEnforcementConfigured: true, trustEnforcementMaximumAgeMs: 180_000 });
  expect(workerReadiness({ state, revision, now: 181_001 })).toMatchObject({ status: "not_ready", trustEnforcementScan: "down" });
  Object.assign(state, { lastTrustEnforcementSucceededAt: 1_000 });
  expect(workerReadiness({ state, revision, now: 181_000 })).toMatchObject({ status: "ready", trustEnforcementScan: "up" });
  expect(workerReadiness({ state, revision, now: 181_001 })).toMatchObject({ status: "not_ready", trustEnforcementScan: "down" });
  Object.assign(state, { lastTrustEnforcementSucceededAt: 182_000 });
  expect(workerReadiness({ state, revision, now: 181_001 })).toMatchObject({ trustEnforcementScan: "down" });
});

test("notificationScan is not_configured while disabled and down after 180 seconds without success when enabled", () => {
  expect(workerReadiness({ state: createWorkerHealthState(), revision, now: 1_000 })).toMatchObject({ notificationScan: "not_configured" });
  const state = createWorkerHealthState();
  Object.assign(state, { initializedAt: 1_000, lastPollSucceededAt: 181_000, lastRefundScanSucceededAt: 181_000,
    publicMediaCleanupConfigured: true, lastPublicMediaCleanupScanSucceededAt: 181_000,
    notificationScanConfigured: true, notificationScanMaximumAgeMs: 180_000 });
  // Spec section 14: the notification scan is reported and alerted on, but never takes the worker out of readiness.
  expect(workerReadiness({ state, revision, now: 181_001 })).toMatchObject({ status: "ready", notificationScan: "down" });
  Object.assign(state, { lastNotificationScanSucceededAt: 1_000 });
  expect(workerReadiness({ state, revision, now: 181_000 })).toMatchObject({ status: "ready", notificationScan: "up" });
  expect(workerReadiness({ state, revision, now: 181_001 })).toMatchObject({ status: "ready", notificationScan: "down" });
  Object.assign(state, { lastNotificationScanSucceededAt: 182_000 });
  expect(workerReadiness({ state, revision, now: 181_001 })).toMatchObject({ notificationScan: "down" });
});
