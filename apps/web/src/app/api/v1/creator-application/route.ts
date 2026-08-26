import { getIdentityRuntime } from "../../../../auth/runtime";
import { withBusinessOperation, withRouteContext } from "../../../../http/route-context";
export const runtime = "nodejs";
export function GET(request: Request) { return withRouteContext(request, () => getIdentityRuntime().creatorHandlers.get(request)); }
export function POST(request: Request) {
  return withRouteContext(request, () =>
    withBusinessOperation(
      { domain: "creator", operation: "draft" },
      () => getIdentityRuntime().creatorHandlers.save(request),
    ),
  );
}
