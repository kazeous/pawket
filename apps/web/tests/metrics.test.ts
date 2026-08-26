import { metricsRegistry } from "@pawket/observability";
import { describe, expect, it } from "vitest";

import {
  constantTimeTokenMatches,
  createMetricsResponse,
} from "../src/http/metrics.js";

const metricsToken = "correct-metrics-token-12345678901234567890";

describe("metrics authorization", () => {
  it("rejects a request without a bearer token", async () => {
    const response = await createMetricsResponse(new Request("http://localhost/api/metrics"), {
      token: metricsToken,
      registry: metricsRegistry,
    });

    expect(response.status).toBe(401);
  });

  it("rejects malformed authorization", async () => {
    const response = await createMetricsResponse(
      new Request("http://localhost/api/metrics", {
        headers: { authorization: `Basic ${metricsToken}` },
      }),
      { token: metricsToken, registry: metricsRegistry },
    );

    expect(response.status).toBe(401);
  });

  it("rejects an incorrect bearer token", async () => {
    const response = await createMetricsResponse(
      new Request("http://localhost/api/metrics", {
        headers: { authorization: "Bearer incorrect-metrics-token-123456789012345678" },
      }),
      { token: metricsToken, registry: metricsRegistry },
    );

    expect(response.status).toBe(401);
  });

  it("returns Prometheus text only to the correct bearer token", async () => {
    const response = await createMetricsResponse(
      new Request("http://localhost/api/metrics", {
        headers: { authorization: `Bearer ${metricsToken}` },
      }),
      { token: metricsToken, registry: metricsRegistry },
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(metricsRegistry.contentType);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toContain("pawket_http_requests_total");
    expect(body).not.toContain(metricsToken);
    expect(body).not.toContain("postgresql://artist:password@db.internal/pawket");
  });

  it("matches only identical tokens", () => {
    expect(constantTimeTokenMatches(metricsToken, metricsToken)).toBe(true);
    expect(constantTimeTokenMatches(metricsToken, "wrong")).toBe(false);
    expect(constantTimeTokenMatches(metricsToken, "x".repeat(metricsToken.length))).toBe(false);
  });

  it("keeps generic request telemetry separate from explicit business outcomes", async () => {
    // Catches route-derived business labels returning to the generic HTTP wrapper.
    metricsRegistry.resetMetrics();
    const routeContext = await import("../src/http/route-context.js");
    await routeContext.withRouteContext(
      new Request("http://localhost/api/v1/auth/register", { method: "POST" }),
      () => Response.json({ code: "INVALID_REQUEST" }, { status: 400 }),
    );

    const afterGenericRequest = await metricsRegistry.metrics();
    expect(afterGenericRequest).toContain(
      'pawket_http_requests_total{method="POST",route="/api/v1/auth",status_code="400"} 1',
    );
    expect(afterGenericRequest).not.toContain("pawket_operational_outcomes_total");
    expect(afterGenericRequest).not.toContain("pawket_auth_operations_total{");

    const withBusinessOperation = (
      routeContext as typeof routeContext & {
        withBusinessOperation?: (
          input: { domain: string; operation: string },
          handler: () => Response | Promise<Response>,
        ) => Promise<Response>;
      }
    ).withBusinessOperation;
    expect(withBusinessOperation).toEqual(expect.any(Function));
    await withBusinessOperation?.({ domain: "auth", operation: "registration" }, () =>
      Response.json({ code: "INVALID_REQUEST" }, { status: 400 }),
    );

    expect(await metricsRegistry.metrics()).toContain(
      'pawket_auth_operations_total{operation="registration",outcome="rejected"} 1',
    );
  });
});
