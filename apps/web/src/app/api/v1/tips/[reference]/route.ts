import { withTipRoute } from "../../../../../http/tip-route";
import type { RouteContext } from "../../../../../http/route-context";
import { getPlatformRuntime } from "../../../../../platform/runtime";

export const runtime = "nodejs";
export function GET(request: Request, context: RouteContext<"/api/v1/tips/[reference]">) {
  return withTipRoute(request, async () => getPlatformRuntime().tipHandlers.receipt(request, (await context.params).reference));
}
