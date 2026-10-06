import { expect, test } from "vitest";
import { UnsafeStructuredDataError } from "@pawket/security/structured-data";
import { metricsRegistry, recordCommissionFileOperation, setCommissionFileBacklogMetrics, setCommissionFileScannerMetric, setWorkerScanHealthMetric,
  setWorkerLastSuccessMetric, setCommissionOperationalMetrics, setCommissionFulfillmentConfiguredMetric, setCommissionFulfillmentPausedMetric } from "../src/index.js";

test("initial signature age is unknown before any probe", async () => {
  expect(await metricsRegistry.metrics()).toContain("pawket_commission_file_signature_age_seconds -1");
});

test("commission file metrics accept only fixed labels and sane values", () => {
  for (const value of [{ operation: "scan", outcome: "reference.png" }, { operation: "commission/abc", outcome: "clean" }, { operation: "__proto__", outcome: "failed" }]) {
    expect(() => recordCommissionFileOperation(value)).toThrow(UnsafeStructuredDataError);
  }
  expect(() => recordCommissionFileOperation({ operation: "maintenance", outcome: "purged", count: 501 })).toThrow(UnsafeStructuredDataError);
  expect(() => setCommissionFileBacklogMetrics({ scanning: -1, oldestScanningSeconds: null, retentionDue: 0 })).toThrow(UnsafeStructuredDataError);
  expect(() => setCommissionFileScannerMetric({ up: "yes" as unknown as boolean, signatureAgeSeconds: 1 })).toThrow(UnsafeStructuredDataError);
});
test("commission file metrics render without private values", async () => {
  recordCommissionFileOperation({ operation: "scan", outcome: "clean" });
  setCommissionFileScannerMetric({ up: true, signatureAgeSeconds: 3_600 });
  setCommissionFileBacklogMetrics({ scanning: 2, oldestScanningSeconds: 120, retentionDue: 1 });
  setWorkerScanHealthMetric({ scan: "commission_files", healthy: true });
  const text = await metricsRegistry.metrics();
  expect(text).toContain('pawket_commission_file_operations_total{operation="scan",outcome="clean"} 1');
  expect(text).toContain("pawket_commission_file_scanner_up 1");
  expect(text).toContain("pawket_commission_file_signature_age_seconds 3600");
  expect(text).toContain("pawket_commission_files_scanning 2");
  expect(text).toContain('pawket_worker_scan_healthy{scan="commission_files"} 1');
});

const fulfillmentReport = { requested: 0, quoted: 0, awaitingPayment: 0, inProgress: 1, delivered: 3, completed: 5,
  completedBuyer: 2, completedAutomatic: 3, completionBacklog: 1, lateDeliveries: 2, draftSubmissions: 4, finalSubmissions: 8,
  expiredRequests: 0, expiredQuotes: 0, expiredPayments: 0, oldestExpiryLagSeconds: 0, overdue: 0, retentionUnacceptedClosed: 0, retentionAccepted: 9 };
test("fulfillment gauges expose only fixed state and kind labels", async () => {
  setCommissionOperationalMetrics(fulfillmentReport);
  setCommissionFulfillmentConfiguredMetric(true); setCommissionFulfillmentPausedMetric(false);
  setWorkerScanHealthMetric({ scan: "commission_fulfillment", healthy: true });
  setWorkerLastSuccessMetric({ scan: "commission_fulfillment", timestampSeconds: 100 });
  const text = await metricsRegistry.metrics();
  for (const line of ['pawket_commission_orders_current{state="delivered"} 3', 'pawket_commission_orders_current{state="completed"} 5',
    'pawket_commission_completions{kind="buyer_accepted"} 2', 'pawket_commission_completions{kind="review_window_elapsed"} 3',
    "pawket_commission_completion_backlog 1", "pawket_commission_late_deliveries 2", 'pawket_commission_submissions{kind="draft"} 4',
    'pawket_commission_submissions{kind="final"} 8', "pawket_commission_fulfillment_configured 1", "pawket_commission_fulfillment_paused 0",
    'pawket_worker_scan_healthy{scan="commission_fulfillment"} 1']) expect(text.includes(line)).toBe(true);
  const metrics = await metricsRegistry.getMetricsAsJSON();
  for (const name of ["completions", "completion_backlog", "late_deliveries", "submissions", "fulfillment_configured", "fulfillment_paused"]) {
    const metric = metrics.find((item) => item.name === `pawket_commission_${name}`)!;
    expect(metric.type).toBe("gauge");
    for (const value of metric.values) expect(Object.keys(value.labels)).toEqual(["completions", "submissions"].includes(name) ? ["kind"] : []);
  }
});
test("fulfillment counts and pause switches reject invalid values before publishing", () => {
  for (const patch of [{ delivered: -1 }, { completed: 0.5 }, { completedBuyer: 6 }, { completedAutomatic: -1 },
    { completionBacklog: 4 }, { lateDeliveries: Infinity }, { draftSubmissions: -1 }, { finalSubmissions: NaN }]) {
    expect(() => setCommissionOperationalMetrics({ ...fulfillmentReport, ...patch })).toThrow(UnsafeStructuredDataError);
  }
  expect(() => setCommissionFulfillmentConfiguredMetric("yes" as unknown as boolean)).toThrow(UnsafeStructuredDataError);
  expect(() => setCommissionFulfillmentPausedMetric("yes" as unknown as boolean)).toThrow(UnsafeStructuredDataError);
});
