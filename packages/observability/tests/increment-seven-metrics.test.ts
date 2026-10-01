import { expect, test } from "vitest";
import { UnsafeStructuredDataError } from "@pawket/security/structured-data";
import { metricsRegistry, recordCommissionFileOperation, setCommissionFileBacklogMetrics, setCommissionFileScannerMetric, setWorkerScanHealthMetric } from "../src/index.js";

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
