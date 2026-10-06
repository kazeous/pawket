import { withCommissionRoute } from "../../../../../../../http/commission-route";
import { getPlatformRuntime } from "../../../../../../../platform/runtime";
import type { RouteContext } from "../../../../../../../http/route-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request, context: RouteContext<"/api/v1/creator/commissions/[orderId]/thread">) {
  return withCommissionRoute(request, async () => {
    return getPlatformRuntime().commissionHandlers.thread(request, (await context.params).orderId, "creator");
  });
}
