import { randomUUID } from "node:crypto";

import {
  recordAuthOperation,
  recordCreatorOperation,
  recordHttpRequestMetrics,
  recordReceivingProofOperation,
  recordRefundOperation,
} from "@pawket/observability/metrics";
import { withRequestContext } from "@pawket/observability/request-context";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_BUSINESS_METRIC_BODY_BYTES = 8_192;

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

type BusinessOperation =
  | { domain: "auth"; operation: "registration" | "verification" | "login" | "oauth_callback" | "reset" | "mfa" | "session" | "security_change" }
  | { domain: "creator"; operation: "draft" | "submit" | "withdraw" | "changes_requested" | "approve" | "reject" | "reopen" | "suspend" | "reinstate" }
  | { domain: "receiving_proof"; operation: "challenge" | "report" | "matched" | "unmatched" }
  | { domain: "refund"; operation: "window" | "sent" | "attention_required" };

type BusinessOutcome = "succeeded" | "rejected" | "retryable_failure" | "attention_required";

function outcomeForStatus(status: number): Exclude<BusinessOutcome, "attention_required"> {
  if (status >= 500) return "retryable_failure";
  if (status >= 400) return "rejected";
  return "succeeded";
}

function recordBusinessOperation(
  input: BusinessOperation,
  outcome: BusinessOutcome,
): void {
  const metric = { operation: input.operation, outcome };
  switch (input.domain) {
    case "auth":
      recordAuthOperation(metric);
      break;
    case "creator":
      recordCreatorOperation(metric);
      break;
    case "receiving_proof":
      recordReceivingProofOperation(metric);
      break;
    case "refund":
      recordRefundOperation(metric);
      break;
  }
}

export async function readBusinessMetricField(
  request: Request,
  field: "action" | "outcome",
): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (!contentLength || !/^\d+$/u.test(contentLength)) return undefined;
  const bytes = Number(contentLength);
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_BUSINESS_METRIC_BODY_BYTES) {
    return undefined;
  }
  try {
    const value = await request.clone().json() as Record<string, unknown>;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value[field]
      : undefined;
  } catch {
    return undefined;
  }
}

export async function withBusinessOperation(
  input: BusinessOperation,
  handler: () => Response | Promise<Response>,
): Promise<Response> {
  let status = 500;
  try {
    const response = await handler();
    status = response.status;
    return response;
  } finally {
    const outcome =
      input.domain === "refund" && input.operation === "attention_required" && status < 400
        ? "attention_required"
        : outcomeForStatus(status);
    recordBusinessOperation(input, outcome);
  }
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
    }
  });
}
