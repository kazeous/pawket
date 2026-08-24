import { getIdentityRuntime } from "../../../../../../auth/runtime";
import { withRouteContext } from "../../../../../../http/route-context";

export const runtime = "nodejs";

export function POST(request: Request): Promise<Response> {
  return withRouteContext(request, () =>
    getIdentityRuntime().handlers.completeEmailChange(request),
  );
}
