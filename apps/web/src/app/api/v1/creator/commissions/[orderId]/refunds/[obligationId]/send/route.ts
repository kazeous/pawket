import { withCommissionRoute } from "../../../../../../../../../http/commission-route";
import { getPlatformRuntime } from "../../../../../../../../../platform/runtime";
import type { RouteContext } from "../../../../../../../../../http/route-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request, context: RouteContext<"/api/v1/creator/commissions/[orderId]/refunds/[obligationId]/send">) {
  return withCommissionRoute(request, async () => {
    const params = await context.params;
    return getPlatformRuntime().resolutionHandlers.recordRefundSend(request, params.orderId, params.obligationId);
  });
}
