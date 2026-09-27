import { commissionJson } from "../platform/commission-http";
import { withRouteContext } from "./route-context";

export function withCommissionRoute(request: Request, handler: () => Response | Promise<Response>): Promise<Response> {
  return withRouteContext(request, async () => {
    try { return await handler(); } catch { return commissionJson(503, { code: "dependency_unavailable" }); }
  });
}
