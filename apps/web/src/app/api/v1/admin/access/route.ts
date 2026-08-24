import { getIdentityRuntime } from "../../../../../auth/runtime";
import { withRouteContext } from "../../../../../http/route-context";

export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return withRouteContext(request, async () => {
    try {
      const decision = await getIdentityRuntime().authorizeOwner(request.headers);
      if (decision === "authorized") {
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      }
      return Response.json(
        { code: decision === "unauthenticated" ? "AUTHENTICATION_REQUIRED" : "OWNER_REQUIRED" },
        { status: decision === "unauthenticated" ? 401 : 403, headers: { "cache-control": "no-store" } },
      );
    } catch {
      return Response.json(
        { code: "AUTHORIZATION_UNAVAILABLE" },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
  });
}
