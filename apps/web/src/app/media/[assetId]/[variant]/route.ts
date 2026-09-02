import {
  type RouteContext,
  withBusinessOperation,
  withRouteContext,
} from "../../../../http/route-context";
import { getPlatformRuntime } from "../../../../platform/runtime";

export const runtime = "nodejs";

async function deliver(
  request: Request,
  context: RouteContext<"/media/[assetId]/[variant]">,
) {
  const { assetId, variant } = await context.params;
  return withRouteContext(request, () => {
    const handler = () => getPlatformRuntime().mediaHandlers.deliver(request, assetId, variant);
    return variant === "master" || variant === "thumb" || variant === "display" || variant === "large"
      ? withBusinessOperation(
          { domain: "public_media", operation: "delivery", variant },
          handler,
        )
      : handler();
  });
}

export const GET = deliver;
export const HEAD = deliver;
