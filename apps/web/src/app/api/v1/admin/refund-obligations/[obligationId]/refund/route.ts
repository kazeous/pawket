import { getIdentityRuntime } from "../../../../../../../auth/runtime";
import {
  readBusinessMetricField,
  withBusinessOperation,
  withRouteContext,
} from "../../../../../../../http/route-context";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ obligationId: string }> },
) {
  const { obligationId } = await context.params;
  return withRouteContext(request, async () => {
    const operation = await readBusinessMetricField(request, "outcome");
    if (operation !== "sent" && operation !== "attention_required") {
      return getIdentityRuntime().paymentsHandlers.recordRefund(request, obligationId);
    }
    return withBusinessOperation(
      { domain: "refund", operation },
      () => getIdentityRuntime().paymentsHandlers.recordRefund(request, obligationId),
    );
  });
}
