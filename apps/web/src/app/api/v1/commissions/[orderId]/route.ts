import { withCommissionRoute } from "../../../../../http/commission-route";
import { getPlatformRuntime } from "../../../../../platform/runtime";
import type { RouteContext } from "../../../../../http/route-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request, context: RouteContext<"/api/v1/commissions/[orderId]">) {
  return withCommissionRoute(request, async () => getPlatformRuntime().commissionHandlers.detail(request, (await context.params).orderId, "buyer"));
}
