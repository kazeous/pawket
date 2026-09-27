import { withCommissionRoute } from "../../../../../../../http/commission-route";
import { getPlatformRuntime } from "../../../../../../../platform/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request) {
  return withCommissionRoute(request, () => getPlatformRuntime().commissionHandlers.changePackage(request));
}
