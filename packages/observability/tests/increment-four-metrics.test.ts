import { describe, expect, test } from "vitest";
import { UnsafeStructuredDataError } from "@pawket/security/structured-data";
import { metricsRegistry, recordTipOperation, setTipPaymentsEnabledMetric, setWorkerScanHealthMetric } from "../src/index.js";

describe("fixed-vocabulary tip metrics", () => {
  test("rejects identity, bank and guest values as labels or unbounded counts", () => {
    for (const input of [{ operation: "creator-id", outcome: "accepted" }, { operation: "confirm", outcome: "PW0123456789ABCDEF0123" },
      { operation: "qr", outcome: "0000001234567" }, { operation: "expiry", outcome: "expired", count: 501 }, { operation: "expiry", outcome: "expired", count: -1 },
      { operation: "qr", outcome: "accepted" }, { operation: "__proto__", outcome: "accepted" }]) expect(() => recordTipOperation(input)).toThrow(UnsafeStructuredDataError);
    expect(() => setTipPaymentsEnabledMetric("manual_only" as unknown as boolean)).toThrow(UnsafeStructuredDataError);
  });
  test("records bounded expiry and mode facts without introducing subject labels", async () => {
    recordTipOperation({ operation: "expiry", outcome: "expired", count: 2 }); setTipPaymentsEnabledMetric(false); setWorkerScanHealthMetric({ scan: "tip_expiry", healthy: true });
    const metric = await metricsRegistry.getSingleMetric("pawket_tip_operations_total")!.get();
    expect(metric.values).toContainEqual(expect.objectContaining({ labels: { operation: "expiry", outcome: "expired" }, value: 2 }));
    const text = await metricsRegistry.metrics(); expect(text).toContain("pawket_tip_payments_enabled 0"); expect(text).not.toMatch(/PW0123456789ABCDEF0123|0000001234567|creator-id/u);
  });
});
