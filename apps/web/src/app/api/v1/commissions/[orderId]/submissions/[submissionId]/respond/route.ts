import { withCommissionRoute } from "../../../../../../../../http/commission-route";
import { getPlatformRuntime } from "../../../../../../../../platform/runtime";
import type { RouteContext } from "../../../../../../../../http/route-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request, context: RouteContext<"/api/v1/commissions/[orderId]/submissions/[submissionId]/respond">) {
  return withCommissionRoute(request, async () => {
    const { orderId, submissionId } = await context.params;
    return getPlatformRuntime().commissionHandlers.respond(request, orderId, submissionId);
  });
}
