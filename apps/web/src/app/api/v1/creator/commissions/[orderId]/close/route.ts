import { withCommissionRoute } from "../../../../../../../http/commission-route";
import { getPlatformRuntime } from "../../../../../../../platform/runtime";
import type { RouteContext } from "../../../../../../../http/route-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request, context: RouteContext<"/api/v1/creator/commissions/[orderId]/close">) {
  return withCommissionRoute(request, async () => getPlatformRuntime().commissionHandlers.mutate(request, (await context.params).orderId, "creator", "close"));
}
