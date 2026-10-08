import { withCommissionRoute } from "../../../../../../../http/commission-route";
import { getPlatformRuntime } from "../../../../../../../platform/runtime";
import type { RouteContext } from "../../../../../../../http/route-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request, context: RouteContext<"/api/v1/admin/creators/[userId]/freeze">) {
  return withCommissionRoute(request, async () => {
    const params = await context.params;
    return getPlatformRuntime().caseHandlers.freeze(request, params.userId);
  });
}
