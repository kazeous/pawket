import { withTipRoute } from "../../../../../../../http/tip-route";
import type { RouteContext } from "../../../../../../../http/route-context";
import { getPlatformRuntime } from "../../../../../../../platform/runtime";

export const runtime = "nodejs";

export function GET(request: Request, context: RouteContext<"/api/v1/public/creators/[handle]/tips">) {
  return withTipRoute(request, async () => getPlatformRuntime().tipHandlers.readOffering(request, (await context.params).handle));
}
export function POST(request: Request, context: RouteContext<"/api/v1/public/creators/[handle]/tips">) {
  return withTipRoute(request, async () => getPlatformRuntime().tipHandlers.create(request, (await context.params).handle));
}
