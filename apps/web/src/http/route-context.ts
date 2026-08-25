import { randomUUID } from "node:crypto";

import {
  recordHttpRequestMetrics,
  recordOperationalOutcome,
} from "@pawket/observability/metrics";
import { withRequestContext } from "@pawket/observability/request-context";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const MAX_REQUEST_ID_LENGTH = 128;

export function trustedRequestId(incomingRequestId: string | null): string {
  if (
    incomingRequestId !== null &&
    incomingRequestId.length <= MAX_REQUEST_ID_LENGTH &&
    REQUEST_ID_PATTERN.test(incomingRequestId)
  ) {
    return incomingRequestId;
  }

  return randomUUID();
}

function boundedRoute(pathname: string): string {
  if (pathname === "/" || pathname === "/api/metrics") return pathname;
  if (pathname === "/api/health/live" || pathname === "/api/health/ready") return pathname;
  if (pathname.startsWith("/api/auth/")) return "/api/auth";
  if (pathname.startsWith("/api/v1/admin/")) return "/api/v1/admin";
  if (pathname.startsWith("/api/v1/auth/")) return "/api/v1/auth";
  if (pathname.startsWith("/api/v1/creator-application")) return "/api/v1/creator";
  if (pathname === "/api/v1/me" || pathname.startsWith("/api/v1/me/")) return "/api/v1/me";
  return "unmatched";
}

function boundedOperation(pathname: string): { area: string; operation: string } {
  if (pathname.startsWith("/api/health/")) return { area: "health", operation: "health" };
  if (pathname === "/api/metrics") return { area: "platform", operation: "metrics" };
  if (pathname.includes("refund-obligations")) return { area: "admin", operation: "refund" };
  if (pathname.includes("verification-deposits")) {
    return { area: "admin", operation: "verification_deposit" };
  }
  if (pathname.includes("creator-applications") || pathname.includes("creator-capabilities")) {
    return { area: "admin", operation: "application" };
  }
  if (pathname === "/api/v1/admin/access") return { area: "admin", operation: "access" };
  if (pathname === "/api/v1/auth/register") return { area: "auth", operation: "registration" };
  if (pathname.startsWith("/api/auth/") || pathname.startsWith("/api/v1/auth/")) {
    return { area: "auth", operation: "authentication" };
  }
  if (pathname === "/api/v1/me" || pathname.startsWith("/api/v1/me/")) {
    return { area: "auth", operation: "profile" };
  }
  if (pathname.startsWith("/api/v1/creator-application")) {
    return { area: "creator", operation: "application" };
  }
  return { area: "platform", operation: "access" };
}

function outcomeForStatus(status: number): "success" | "client_error" | "server_error" {
  if (status >= 500) return "server_error";
  if (status >= 400) return "client_error";
  return "success";
}

export function withRouteContext(
  request: Request,
  handler: () => Response | Promise<Response>,
): Promise<Response> {
  const context = Object.freeze({ requestId: trustedRequestId(request.headers.get("x-request-id")) });
  return withRequestContext(context, async () => {
    const startedAt = performance.now();
    const pathname = new URL(request.url).pathname;
    const route = boundedRoute(pathname);
    const operation = boundedOperation(pathname);
    let status = 500;
    try {
      const response = await handler();
      status = response.status;
      return response;
    } finally {
      recordHttpRequestMetrics({
        method: request.method.toUpperCase(),
        route,
        statusCode: status,
        durationSeconds: (performance.now() - startedAt) / 1_000,
      });
      recordOperationalOutcome({
        ...operation,
        outcome: outcomeForStatus(status),
      });
    }
  });
}
