import { withTipRoute } from "../../../../../http/tip-route";
import { getPlatformRuntime } from "../../../../../platform/runtime";

export const runtime = "nodejs";
export function GET(request: Request) {
  return withTipRoute(request, () => getPlatformRuntime().creatorTipHandlers.queue(request));
}
