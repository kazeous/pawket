import { withRouteContext } from "./route-context";
import { recordTipOperation } from "@pawket/observability";

async function observeFailure(request: Request, response: Response) {
  if (request.method !== "POST" || response.ok) return;
  const path = new URL(request.url).pathname;
  const operation = /^\/api\/v1\/public\/creators\/[^/]+\/tips$/u.test(path) ? "create" : /^\/api\/v1\/tips\/[^/]+\/transfer-claims$/u.test(path) ? "claim" : /^\/api\/v1\/creator\/tips\/[^/]+\/confirm$/u.test(path) ? "confirm" : null;
  if (!operation) return;
  try {
    const body: unknown = await response.clone().json(); const code = body && typeof body === "object" && "code" in body ? body.code : null;
    const confirmationOutcomes = ["evidence_mismatch", "bank_transaction_conflict", "intent_not_pending", "idempotency_conflict", "recent_auth_required", "totp_required"];
    const outcome = code === "payments_disabled" ? "disabled" : response.status === 429 ? "rate_limited" : operation === "confirm" && typeof code === "string" && confirmationOutcomes.includes(code) ? code : response.status >= 500 ? "failed" : "rejected";
    recordTipOperation({ operation, outcome });
  } catch { /* Telemetry cannot replace a private response with an error. */ }
}

// Covers composition/configuration failures before the domain HTTP handler
// exists. Never let a private receipt fall through to a generic HTML error.
export function withTipRoute(request: Request, handler: () => Response | Promise<Response>): Promise<Response> {
  return withRouteContext(request, async () => {
    let response: Response;
    try { response = await handler(); } catch {
      response = Response.json({ code: "dependency_unavailable" }, { status: 503, headers: {
        "cache-control": "private, no-store, max-age=0", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
        "cross-origin-resource-policy": "same-origin", "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      } });
    }
    await observeFailure(request, response); return response;
  });
}
