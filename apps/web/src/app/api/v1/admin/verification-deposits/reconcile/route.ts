import { getIdentityRuntime } from "../../../../../../auth/runtime";
import { withBusinessOperation, withRouteContext } from "../../../../../../http/route-context";

export const runtime = "nodejs";

export function POST(request: Request) {
  return withRouteContext(request, async () => {
    const response = await getIdentityRuntime().paymentsHandlers.reconcileDeposit(request);
    let operation: unknown;
    try {
      const body = await response.clone().json() as {
        reconciliation?: { kind?: unknown };
      };
      operation = body.reconciliation?.kind;
    } catch {
      operation = undefined;
    }
    if (operation !== "matched" && operation !== "unmatched") return response;
    return withBusinessOperation(
      { domain: "receiving_proof", operation },
      () => response,
    );
  });
}
