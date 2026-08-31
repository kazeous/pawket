import { type RouteContext, withRouteContext } from "../../../../http/route-context";
import { getPlatformRuntime } from "../../../../platform/runtime";

export const runtime = "nodejs";

async function deliver(
  request: Request,
  context: RouteContext<"/media/[assetId]/[variant]">,
) {
  const { assetId, variant } = await context.params;
  return withRouteContext(request, () => getPlatformRuntime().mediaHandlers.deliver(request, assetId, variant));
}

export const GET = deliver;
export const HEAD = deliver;
