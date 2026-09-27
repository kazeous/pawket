import { withCommissionRoute } from "../../../../../../../http/commission-route";
import { getPlatformRuntime } from "../../../../../../../platform/runtime";
import type { RouteContext } from "../../../../../../../http/route-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request, context: RouteContext<"/api/v1/creator/commissions/[orderId]/confirm">) {
  return withCommissionRoute(request, async () => getPlatformRuntime().commissionHandlers.confirm(request, (await context.params).orderId));
}
