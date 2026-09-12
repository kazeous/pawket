import { expect, test } from "vitest";
import { boundedRoute } from "../src/http/route-context.js";
import { withTipRoute } from "../src/http/tip-route.js";
import { metricsRegistry, recordHttpRequestMetrics } from "@pawket/observability/metrics";

test("tip route metrics never retain concrete creator handles or transfer references", () => {
  expect(boundedRoute("/api/v1/public/creators/synthetic-artist/tips")).toBe("/api/v1/public/creators/[handle]/tips");
  expect(boundedRoute("/api/v1/tips/PW00000000000000000000")).toBe("/api/v1/tips/[reference]");
  expect(boundedRoute("/api/v1/tips/PW00000000000000000000/transfer-claims")).toBe("/api/v1/tips/[reference]/transfer-claims");
  expect(boundedRoute("/api/v1/tips/guest-context")).toBe("/api/v1/tips/guest-context");
});
test("composition failure returns a private safe JSON response", async () => {
  const response = await withTipRoute(new Request("https://pawket.test/api/v1/tips/PW00000000000000000000"), () => { throw new Error("synthetic private failure"); });
  expect(response.status).toBe(503); expect(await response.json()).toEqual({ code: "dependency_unavailable" });
  expect(response.headers.get("cache-control")).toContain("no-store"); expect(response.headers.get("referrer-policy")).toBe("no-referrer");
});
test("metrics accept only fixed route labels and never export a transfer reference", async () => {
  const concrete = "/api/v1/tips/PW00000000000000000000";
  expect(() => recordHttpRequestMetrics({ method: "GET", route: concrete, statusCode: 200, durationSeconds: 0.1 })).toThrow();
  recordHttpRequestMetrics({ method: "GET", route: boundedRoute(concrete), statusCode: 200, durationSeconds: 0.1 });
  expect(await metricsRegistry.metrics()).not.toContain("PW00000000000000000000");
});
