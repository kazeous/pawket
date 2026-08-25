import { getIdentityRuntime } from "../../../../../auth/runtime";
import { withRouteContext } from "../../../../../http/route-context";

export const runtime = "nodejs";

export function GET(request: Request) {
  return withRouteContext(request, () => getIdentityRuntime().paymentsHandlers.listRefundObligations(request));
}
