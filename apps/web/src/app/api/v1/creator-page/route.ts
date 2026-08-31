import { withRouteContext } from "../../../../http/route-context";
import { getPlatformRuntime } from "../../../../platform/runtime";

export const runtime = "nodejs";

export function GET(request: Request) {
  return withRouteContext(request, () => getPlatformRuntime().catalogHandlers.workspace(request));
}

export function POST(request: Request) {
  return withRouteContext(request, () => getPlatformRuntime().catalogHandlers.saveDraft(request));
}
