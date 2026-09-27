import { withCommissionRoute } from "../../../../../../../http/commission-route";
import { getPlatformRuntime } from "../../../../../../../platform/runtime";
import type { RouteContext } from "../../../../../../../http/route-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request, context: RouteContext<"/api/v1/public/creators/[handle]/commissions">) {
  return withCommissionRoute(request, async () => getPlatformRuntime().commissionHandlers.publicPackages(request, (await context.params).handle));
}
