import { expect, test } from "vitest";
import { UnsafeStructuredDataError } from "@pawket/security/structured-data";
import { metricsRegistry, recordCommissionOperation, setCommissionCleanupConfiguredMetric, setCommissionOperationalMetrics } from "../src/index.js";

const report = { requested: 2, quoted: 1, awaitingPayment: 3, inProgress: 4, expiredRequests: 1, expiredQuotes: 0, expiredPayments: 2,
  oldestExpiryLagSeconds: 600, overdue: 1, retentionUnacceptedClosed: 6, retentionAccepted: 7 };
test("commission metrics reject private labels, invalid counts and inconsistent snapshots", () => {
  for (const value of [{ operation: "order-private-id", outcome: "accepted" }, { operation: "confirm", outcome: "PW00000000000000000001" },
    { operation: "__proto__", outcome: "failed" }, { operation: "cleanup", outcome: "creator_manual" }]) {
    expect(() => recordCommissionOperation(value)).toThrow(UnsafeStructuredDataError);
  }
  for (const patch of [{ overdue: 5 }, { expiredRequests: 3 }, { oldestExpiryLagSeconds: Infinity }, { retentionAccepted: -1 }, { requested: 0.5 }]) {
    expect(() => setCommissionOperationalMetrics({ ...report, ...patch })).toThrow(UnsafeStructuredDataError);
  }
  expect(() => setCommissionCleanupConfiguredMetric("enabled" as unknown as boolean)).toThrow(UnsafeStructuredDataError);
});
test("commission telemetry reports aggregate inventory through payment pauses", async () => {
  setCommissionOperationalMetrics(report); setCommissionCleanupConfiguredMetric(true);
  recordCommissionOperation({ operation: "confirm", outcome: "creator_reviewed_sepay" });
  const text = await metricsRegistry.metrics();
  expect(text).toContain("pawket_commission_cleanup_configured 1");
  expect(text).toContain('pawket_commission_expiry_backlog{state="awaiting_payment"} 2');
  expect(text).toContain("pawket_commission_overdue_orders 1");
  expect(text).toContain('pawket_commission_retention_inventory{dataset="unaccepted_closed_90d"} 6');
  expect(text).not.toMatch(/order-private-id|PW00000000000000000001/);
});
