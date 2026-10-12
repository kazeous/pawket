import { withRouteContext, withBusinessOperation } from "../../../../../http/route-context";
import { getPlatformRuntime } from "../../../../../platform/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request) {
  return withRouteContext(request, () => withBusinessOperation({ domain: "content_report", operation: "challenge" },
    () => getPlatformRuntime().trustEnforcementHandlers.challenge(request)));
}
