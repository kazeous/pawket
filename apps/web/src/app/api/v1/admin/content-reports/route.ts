import { withRouteContext } from "../../../../../http/route-context";
import { getPlatformRuntime } from "../../../../../platform/runtime";

export const runtime = "nodejs";

export function GET(request: Request) {
  return withRouteContext(request, () => getPlatformRuntime().trustHandlers.queue(request));
}
