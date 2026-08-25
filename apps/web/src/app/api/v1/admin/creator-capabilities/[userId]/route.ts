import { getIdentityRuntime } from "../../../../../../auth/runtime";
import { withRouteContext } from "../../../../../../http/route-context";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ userId: string }> }) {
  const { userId } = await context.params;
  return withRouteContext(request, () => getIdentityRuntime().creatorReviewHandlers.setCapability(request, userId));
}
