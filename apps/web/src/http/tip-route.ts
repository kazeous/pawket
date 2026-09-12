import { withRouteContext } from "./route-context";

// Covers composition/configuration failures before the domain HTTP handler
// exists. Never let a private receipt fall through to a generic HTML error.
export function withTipRoute(request: Request, handler: () => Response | Promise<Response>): Promise<Response> {
  return withRouteContext(request, async () => {
    try { return await handler(); } catch {
      return Response.json({ code: "dependency_unavailable" }, { status: 503, headers: {
        "cache-control": "private, no-store, max-age=0", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
        "cross-origin-resource-policy": "same-origin", "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      } });
    }
  });
}
