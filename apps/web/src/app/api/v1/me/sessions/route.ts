import { getIdentityRuntime } from "../../../../../auth/runtime";
import { withRouteContext } from "../../../../../http/route-context";

export const runtime = "nodejs";

function handle(request: Request): Promise<Response> {
  return withRouteContext(request, () => getIdentityRuntime().handlers.sessions(request));
}

export const GET = handle;
export const DELETE = handle;
