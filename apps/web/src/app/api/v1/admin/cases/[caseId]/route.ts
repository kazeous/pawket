import { withCommissionRoute } from "../../../../../../http/commission-route";
import { getPlatformRuntime } from "../../../../../../platform/runtime";
import type { RouteContext } from "../../../../../../http/route-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request, context: RouteContext<"/api/v1/admin/cases/[caseId]">) {
  return withCommissionRoute(request, async () => {
    const params = await context.params;
    return getPlatformRuntime().caseHandlers.detail(request, params.caseId);
  });
}
