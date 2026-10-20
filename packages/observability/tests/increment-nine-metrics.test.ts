import { expect, test } from "vitest";
import { UnsafeStructuredDataError } from "@pawket/security/structured-data";
import { metricsRegistry, recordNotificationOperation, recordSecurityEmailMetrics } from "../src/index.js";

test("notification metrics accept only fixed operations and outcomes", () => {
  for (const value of [{ operation: "materialize", outcome: "MARKER-REPORTER" }, { operation: "order/abc", outcome: "created" },
    { operation: "__proto__", outcome: "created" }, { operation: "retention", outcome: "queued" }, { operation: "digest", outcome: "deleted" }]) {
    expect(() => recordNotificationOperation(value)).toThrow(UnsafeStructuredDataError);
  }
  expect(() => recordNotificationOperation({ operation: "materialize", outcome: "created", count: 501 })).toThrow(UnsafeStructuredDataError);
  expect(() => recordNotificationOperation({ operation: "materialize", outcome: "created", count: -1 })).toThrow(UnsafeStructuredDataError);
  expect(() => recordNotificationOperation({ operation: "materialize", outcome: "created", count: 1.5 })).toThrow(UnsafeStructuredDataError);
});
test("notification metrics render with fixed labels and accept the notification email purpose", async () => {
  recordNotificationOperation({ operation: "materialize", outcome: "created" });
  recordNotificationOperation({ operation: "retention", outcome: "deleted", count: 3 });
  recordSecurityEmailMetrics({ purpose: "notification", outcome: "queued" });
  const text = await metricsRegistry.metrics();
  expect(text).toContain('pawket_notification_operations_total{operation="materialize",outcome="created"} 1');
  expect(text).toContain('pawket_notification_operations_total{operation="retention",outcome="deleted"} 3');
  expect(text).toContain('pawket_security_emails_total{purpose="notification",outcome="queued"} 1');
});
