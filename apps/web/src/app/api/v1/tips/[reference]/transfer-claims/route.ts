import { withTipRoute } from "../../../../../../http/tip-route";
import type { RouteContext } from "../../../../../../http/route-context";
import { getPlatformRuntime } from "../../../../../../platform/runtime";

export const runtime = "nodejs";
export function POST(request: Request, context: RouteContext<"/api/v1/tips/[reference]/transfer-claims">) {
  return withTipRoute(request, async () => getPlatformRuntime().tipHandlers.claim(request, (await context.params).reference));
}
