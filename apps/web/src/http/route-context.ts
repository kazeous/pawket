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

type DynamicRouteParameters<Path extends string> =
  Path extends `${string}[${infer Parameter}]${infer Rest}`
    ? Record<Parameter, string> & DynamicRouteParameters<Rest>
    : Record<never, never>;

export type RouteContext<Path extends string> = Readonly<{
  params: Promise<DynamicRouteParameters<Path>>;
}>;

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

const uploadCompletionRoute = /^\/api\/v1\/creator-page\/media\/uploads\/[^/]+\/complete$/u;
const reportTriageRoute = /^\/api\/v1\/admin\/content-reports\/[^/]+$/u;
const mediaDeliveryRoute = /^\/media\/[^/]+\/[^/]+$/u;

export function boundedRoute(pathname: string): string {
  if (pathname === "/" || pathname === "/api/metrics") return pathname;
  if (pathname === "/api/health/live" || pathname === "/api/health/ready") return pathname;
  if (pathname === "/api/v1/creator-page") return pathname;
  if (pathname === "/api/v1/creator-page/handle") return pathname;
  if (pathname === "/api/v1/creator-page/showcases") return pathname;
  if (pathname === "/api/v1/creator-page/publish") return pathname;
  if (pathname === "/api/v1/creator-page/unpublish") return pathname;
  if (pathname === "/api/v1/creator-page/media/uploads") return pathname;
  if (uploadCompletionRoute.test(pathname)) return "/api/v1/creator-page/media/uploads/[intentId]/complete";
  if (pathname === "/api/v1/content-reports" || pathname === "/api/v1/content-reports/challenge") return pathname;
  if (pathname === "/api/v1/admin/content-reports") return pathname;
  if (reportTriageRoute.test(pathname)) return "/api/v1/admin/content-reports/[reportId]";
  if (mediaDeliveryRoute.test(pathname)) return "/media/[assetId]/[variant]";
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

export function recordBusinessOperationOutcome(
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
  const clone = request.clone();
  if (!clone.body) return undefined;
  const reader = clone.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let cancelled = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_BUSINESS_METRIC_BODY_BYTES) {
        cancelled = true;
        void reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(chunk.value);
    }
    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)[field]
      : undefined;
  } catch {
    cancelled = true;
    void reader.cancel().catch(() => undefined);
    return undefined;
  } finally {
    if (!cancelled) reader.releaseLock();
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
    recordBusinessOperationOutcome(input, outcome);
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
