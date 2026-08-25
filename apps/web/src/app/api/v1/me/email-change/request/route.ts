import { getIdentityRuntime } from "../../../../../../auth/runtime";
import { withBusinessOperation, withRouteContext } from "../../../../../../http/route-context";

export const runtime = "nodejs";

export function POST(request: Request): Promise<Response> {
  return withRouteContext(request, () =>
    withBusinessOperation(
      { domain: "auth", operation: "security_change" },
      () => getIdentityRuntime().handlers.requestEmailChange(request),
    ),
  );
}
