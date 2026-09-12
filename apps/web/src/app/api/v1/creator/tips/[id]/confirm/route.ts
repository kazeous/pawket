import { withTipRoute } from "../../../../../../../http/tip-route";
import type { RouteContext } from "../../../../../../../http/route-context";
import { getPlatformRuntime } from "../../../../../../../platform/runtime";

export const runtime = "nodejs";
export function POST(request: Request, context: RouteContext<"/api/v1/creator/tips/[id]/confirm">) {
  return withTipRoute(request, async () => getPlatformRuntime().creatorTipHandlers.confirm(request, (await context.params).id));
}
