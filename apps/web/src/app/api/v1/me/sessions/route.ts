import { getIdentityRuntime } from "../../../../../auth/runtime";
import { withBusinessOperation, withRouteContext } from "../../../../../http/route-context";

export const runtime = "nodejs";

function handle(request: Request): Promise<Response> {
  return withRouteContext(request, () =>
    withBusinessOperation(
      { domain: "auth", operation: "session" },
      () => getIdentityRuntime().handlers.sessions(request),
    ),
  );
}

export const GET = handle;
export const DELETE = handle;
