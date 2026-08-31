import { getRequestContext } from "@pawket/observability";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import nextConfig from "../next.config";
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

  it("configures the required headers globally in Next", async () => {
    const configuredHeaders = await nextConfig.headers?.();
    const globalHeaders = configuredHeaders?.find((entry) => entry.source === "/:path*")?.headers;

    expect(Object.fromEntries(globalHeaders?.map(({ key, value }) => [key.toLowerCase(), value]) ?? [])).toEqual(
      expectedSecurityHeaders,
    );
  });

  it("marks identity, creator, security, and owner pages as private no-store surfaces", async () => {
    const configuredHeaders = await nextConfig.headers?.();
    const sensitiveSources = ["/", "/register", "/verify-email/:path*", "/sign-in/:path*", "/forgot-password", "/reset-password", "/settings/:path*", "/creator/:path*", "/admin/:path*"];

    for (const source of sensitiveSources) {
      const headers = configuredHeaders?.find((entry) => entry.source === source)?.headers ?? [];
      const values = Object.fromEntries(headers.map(({ key, value }) => [key.toLowerCase(), value]));
      expect(values).toEqual({
        "cache-control": "private, no-store, max-age=0",
        "referrer-policy": "no-referrer",
      });
    }
  });

  it("preserves a valid request ID through the proxy and onto the response", () => {
    const response = proxy(
      new NextRequest("http://localhost/api/health/live", {
        headers: { "x-request-id": "gateway.7:trace_id-1" },
      }),
    );

    expect(response.headers.get("x-request-id")).toBe("gateway.7:trace_id-1");
    expect(response.headers.get("x-middleware-request-x-request-id")).toBe("gateway.7:trace_id-1");
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

  it.each([
    ["/creator", "private, no-store"],
    ["/creator/preview", "private, no-store"],
    ["/admin/content-reports", "private, no-store"],
    ["/creators", "public, no-store"],
    ["/creators/artist-handle", "public, no-store"],
    ["/media/10000000-0000-4000-8000-000000000001/thumb", "public, no-store"],
    ["/sitemap.xml", "public, no-store"],
  ])("sets the visibility-sensitive edge cache policy for %s", (path, cacheControl) => {
    // Catches a private or effective-visibility surface becoming cacheable at the edge.
    const response = proxy(new NextRequest(`http://localhost${path}`));

    expect(response.headers.get("cache-control")).toBe(cacheControl);
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

  it("uses the proxy-forwarded canonical ID as the route context ID", async () => {
    const proxied = proxy(
      new NextRequest("http://localhost/api/health/live", {
        headers: { "x-request-id": "invalid/request-id" },
      }),
    );
    const forwarded = proxied.headers.get("x-middleware-request-x-request-id");
    let contextRequestId: string | undefined;

    await withRouteContext(
      new Request("http://localhost/api/health/live", {
        headers: { "x-request-id": forwarded ?? "" },
      }),
      () => {
        contextRequestId = getRequestContext()?.requestId;
        return new Response("ok");
      },
    );

    expect(contextRequestId).toBe(forwarded);
  });

  it("retains isolated request contexts across asynchronous handlers", async () => {
    const requestIds = await Promise.all([
      withRouteContext(
        new Request("http://localhost", { headers: { "x-request-id": "request-one" } }),
        async () => {
          await Promise.resolve();
          return new Response(getRequestContext()?.requestId);
        },
      ).then((response) => response.text()),
      withRouteContext(
        new Request("http://localhost", { headers: { "x-request-id": "request-two" } }),
        async () => {
          await Promise.resolve();
          return new Response(getRequestContext()?.requestId);
        },
      ).then((response) => response.text()),
    ]);

    expect(requestIds).toEqual(["request-one", "request-two"]);
  });
});
