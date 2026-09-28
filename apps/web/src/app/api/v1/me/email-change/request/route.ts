import { retiredIdentityResponse } from "@pawket/identity";
import { withBusinessOperation, withRouteContext } from "../../../../../../http/route-context";

export const runtime = "nodejs";

export function POST(request: Request): Promise<Response> {
  return withRouteContext(request, () =>
    withBusinessOperation(
      { domain: "auth", operation: "security_change" },
      async () => retiredIdentityResponse(),
    ),
  );
}
