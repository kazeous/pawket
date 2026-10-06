import { withCommissionRoute } from "../../../../../../http/commission-route";
import { getPlatformRuntime } from "../../../../../../platform/runtime";
import type { RouteContext } from "../../../../../../http/route-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request, context: RouteContext<"/api/v1/commissions/[orderId]/messages">) {
  return withCommissionRoute(request, async () => {
    return getPlatformRuntime().commissionHandlers.message(request, (await context.params).orderId, "buyer");
  });
}
