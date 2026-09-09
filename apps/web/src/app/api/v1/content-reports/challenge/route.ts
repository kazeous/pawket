import { withBusinessOperation, withRouteContext } from "../../../../../http/route-context";
import { getPlatformRuntime } from "../../../../../platform/runtime";

export const runtime = "nodejs";

export function GET(request: Request) {
  return withRouteContext(request, () =>
    withBusinessOperation(
      { domain: "content_report", operation: "challenge" },
      () => getPlatformRuntime().trustHandlers.challenge(request),
    ),
  );
}
