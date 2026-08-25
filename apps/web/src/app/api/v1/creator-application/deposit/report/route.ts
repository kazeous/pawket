import { getIdentityRuntime } from "../../../../../../auth/runtime";
import { withBusinessOperation, withRouteContext } from "../../../../../../http/route-context";

export const runtime = "nodejs";

export function POST(request: Request) {
  return withRouteContext(request, () =>
    withBusinessOperation(
      { domain: "receiving_proof", operation: "report" },
      () => getIdentityRuntime().paymentsHandlers.reportDepositSent(request),
    ),
  );
}
