import { withTipRoute } from "../../../../../http/tip-route";
import { getPlatformRuntime } from "../../../../../platform/runtime";

export const runtime = "nodejs";
export function GET(request: Request) {
  return withTipRoute(request, () => getPlatformRuntime().creatorTipSettingsHandlers.read(request));
}
export function POST(request: Request) {
  return withTipRoute(request, () => getPlatformRuntime().creatorTipSettingsHandlers.save(request));
}
