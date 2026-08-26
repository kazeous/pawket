import { getIdentityRuntime } from "../../../../../../auth/runtime";
import {
  readBusinessMetricField,
  withBusinessOperation,
  withRouteContext,
} from "../../../../../../http/route-context";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ userId: string }> }) {
  const { userId } = await context.params;
  return withRouteContext(request, async () => {
    const operation = await readBusinessMetricField(request, "action");
    if (operation !== "suspend" && operation !== "reinstate") {
      return getIdentityRuntime().creatorReviewHandlers.setCapability(request, userId);
    }
    return withBusinessOperation(
      { domain: "creator", operation },
      () => getIdentityRuntime().creatorReviewHandlers.setCapability(request, userId),
    );
  });
}
