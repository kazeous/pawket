import { withCommissionRoute } from "../../../../http/commission-route";
import { withBusinessOperation } from "../../../../http/route-context";
import { getPlatformRuntime } from "../../../../platform/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request) {
  return withCommissionRoute(request, () => withBusinessOperation({ domain: "content_report", operation: "submit" },
    () => getPlatformRuntime().trustEnforcementHandlers.submit(request)));
}
