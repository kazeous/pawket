import { withRouteContext } from "../../../../../../http/route-context";
import { getPlatformRuntime } from "../../../../../../platform/runtime";

export const runtime = "nodejs";

export function POST(request: Request) {
  return withRouteContext(request, () => getPlatformRuntime().mediaCommandHandlers.createUpload(request));
}
