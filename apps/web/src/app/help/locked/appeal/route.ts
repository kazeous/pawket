import { withCommissionRoute } from "../../../../http/commission-route";
import { getPlatformRuntime } from "../../../../platform/runtime";

export const runtime = "nodejs";
export function POST(request: Request) {
  return withCommissionRoute(request, () => getPlatformRuntime().appealHandlers.lockedSubmit(request));
}
