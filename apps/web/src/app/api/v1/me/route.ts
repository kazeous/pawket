import { getIdentityRuntime } from "../../../../auth/runtime";
import { withRouteContext } from "../../../../http/route-context";

export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return withRouteContext(request, () => getIdentityRuntime().handlers.me(request));
}
