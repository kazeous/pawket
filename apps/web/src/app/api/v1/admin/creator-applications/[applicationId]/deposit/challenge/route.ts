import { getIdentityRuntime } from "../../../../../../../../auth/runtime";
import { withRouteContext } from "../../../../../../../../http/route-context";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ applicationId: string }> },
) {
  const { applicationId } = await context.params;
  return withRouteContext(request, () =>
    getIdentityRuntime().paymentsHandlers.issueChallenge(request, applicationId),
  );
}
