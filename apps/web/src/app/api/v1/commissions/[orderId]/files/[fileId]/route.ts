import { withCommissionRoute } from "../../../../../../../http/commission-route";
import { getPlatformRuntime } from "../../../../../../../platform/runtime";
import type { RouteContext } from "../../../../../../../http/route-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request, context: RouteContext<"/api/v1/commissions/[orderId]/files/[fileId]">) {
  return withCommissionRoute(request, async () => { const { orderId, fileId } = await context.params; return getPlatformRuntime().commissionFileHandlers.download(request, orderId, fileId); });
}
