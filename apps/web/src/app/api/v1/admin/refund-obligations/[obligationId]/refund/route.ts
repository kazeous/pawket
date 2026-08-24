import { getIdentityRuntime } from "../../../../../../../auth/runtime";
import { withRouteContext } from "../../../../../../../http/route-context";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ obligationId: string }> },
) {
  const { obligationId } = await context.params;
  return withRouteContext(request, () =>
    getIdentityRuntime().paymentsHandlers.recordRefund(request, obligationId),
  );
}
