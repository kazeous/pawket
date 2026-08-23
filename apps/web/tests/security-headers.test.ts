import { getRequestContext } from "@pawket/observability";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { proxy } from "../src/proxy.js";
import { withRouteContext } from "../src/http/route-context.js";
import { applySecurityHeaders } from "../src/http/security-headers.js";

const expectedSecurityHeaders = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "cross-origin-opener-policy": "same-origin",
  "x-frame-options": "DENY",
};

describe("HTTP hardening", () => {
  it("sets the required response security headers without a CSP", () => {
    const response = applySecurityHeaders(new Response("ok"));

    for (const [name, value] of Object.entries(expectedSecurityHeaders)) {
      expect(response.headers.get(name)).toBe(value);
    }
    expect(response.headers.has("content-security-policy")).toBe(false);
  });

  it("preserves a valid request ID through the proxy and onto the response", () => {
    const response = proxy(
      new NextRequest("http://localhost/api/health/live", {
        headers: { "x-request-id": "gateway.7:trace_id-1" },
      }),
    );

    expect(response.headers.get("x-request-id")).toBe("gateway.7:trace_id-1");
  });

  it("replaces malformed request IDs rather than reflecting them", () => {
    const response = proxy(
      new NextRequest("http://localhost/api/health/live", {
        headers: { "x-request-id": "invalid/request-id" },
      }),
    );
    const requestId = response.headers.get("x-request-id");

    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(requestId).not.toBe("invalid/request-id");
  });

  it("replaces request IDs longer than 128 characters", () => {
    const oversizedRequestId = "a".repeat(129);
    const response = proxy(
      new NextRequest("http://localhost/api/health/live", {
        headers: { "x-request-id": oversizedRequestId },
      }),
    );

    expect(response.headers.get("x-request-id")).not.toBe(oversizedRequestId);
  });

  it("uses an immutable, sanitized request context for route handlers", async () => {
    let receivedRequestId: string | undefined;
    const response = await withRouteContext(
      new Request("http://localhost/api/health/live", {
        headers: { "x-request-id": "invalid/request-id" },
      }),
      () => {
        const context = getRequestContext();
        receivedRequestId = context?.requestId;
        expect(Object.isFrozen(context)).toBe(true);
        return new Response("ok");
      },
    );

    expect(receivedRequestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(response.status).toBe(200);
  });
});
