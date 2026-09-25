import { describe, expect, test } from "vitest";
import { UnsafeStructuredDataError } from "@pawket/security/structured-data";
import { metricsRegistry, recordSePayOperation, setSePayBacklogMetrics, setSePayRecoveryEnabledMetric } from "../src/index.js";

describe("fixed SePay metric vocabulary", () => {
  test("rejects payment identifiers, cross-operation outcomes and invalid durations", () => {
    for (const value of [{ operation: "creator-123", outcome: "accepted" }, { operation: "ingress", outcome: "PW00000000000000000001" },
      { operation: "lookup", outcome: "confirmed" }, { operation: "__proto__", outcome: "failed" },
      { operation: "reconcile", outcome: "confirmed", durationSeconds: 1 }, { operation: "lookup", outcome: "failed", durationSeconds: -1 }]) {
      expect(() => recordSePayOperation(value)).toThrow(UnsafeStructuredDataError);
    }
    expect(() => setSePayBacklogMetrics({ pending: -1, reviewRequired: 0, oldestAgeSeconds: 0 })).toThrow(UnsafeStructuredDataError);
    expect(() => setSePayRecoveryEnabledMetric("enabled" as unknown as boolean)).toThrow(UnsafeStructuredDataError);
  });
  test("exports only aggregate backlog and fixed operation labels", async () => {
    recordSePayOperation({ operation: "lookup", outcome: "inconclusive", durationSeconds: 0.25 });
    recordSePayOperation({ operation: "ingress", outcome: "conflict" });
    setSePayBacklogMetrics({ pending: 2, reviewRequired: 3, oldestAgeSeconds: 600 }); setSePayRecoveryEnabledMetric(false);
    const text = await metricsRegistry.metrics();
    expect(text).toContain('pawket_sepay_operations_total{operation="lookup",outcome="inconclusive"} 1');
    expect(text).toContain('pawket_sepay_inbox_total{state="review_required"} 3');
    expect(text).toContain("pawket_sepay_inbox_oldest_age_seconds 600");
    expect(text).toContain("pawket_sepay_recovery_enabled 0");
    expect(text).not.toMatch(/creator-123|PW00000000000000000001/);
  });
});
