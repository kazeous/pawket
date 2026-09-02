import { withBusinessOperation, withRouteContext } from "../../../../http/route-context";
import { getPlatformRuntime } from "../../../../platform/runtime";

export const runtime = "nodejs";

export function GET(request: Request) {
  return withRouteContext(request, () => getPlatformRuntime().catalogHandlers.workspace(request));
}

export function POST(request: Request) {
  return withRouteContext(request, () =>
    withBusinessOperation(
      { domain: "catalog", operation: "draft" },
      () => getPlatformRuntime().catalogHandlers.saveDraft(request),
    ),
  );
}
