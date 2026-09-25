import { withTipRoute } from "@/http/tip-route";
import { getPlatformRuntime } from "@/platform/runtime";

export const runtime = "nodejs";
export function POST(request: Request) {
  return withTipRoute(request, () => getPlatformRuntime().sepayHandlers.start(request));
}
