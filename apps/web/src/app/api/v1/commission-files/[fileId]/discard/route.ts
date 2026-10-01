import { withCommissionRoute } from "../../../../../../http/commission-route";
import { getPlatformRuntime } from "../../../../../../platform/runtime";
import type { RouteContext } from "../../../../../../http/route-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request, context: RouteContext<"/api/v1/commission-files/[fileId]/discard">) {
  return withCommissionRoute(request, async () => getPlatformRuntime().commissionFileHandlers.discard(request, (await context.params).fileId));
}
