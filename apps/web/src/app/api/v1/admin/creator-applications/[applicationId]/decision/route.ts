import { getIdentityRuntime } from "../../../../../../../auth/runtime";
import {
  readBusinessMetricField,
  withBusinessOperation,
  withRouteContext,
} from "../../../../../../../http/route-context";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ applicationId: string }> }) {
  const { applicationId } = await context.params;
  return withRouteContext(request, async () => {
    const action = await readBusinessMetricField(request, "action");
    const operation = action === "request_changes" ? "changes_requested" : action;
    if (
      operation !== "changes_requested" &&
      operation !== "approve" &&
      operation !== "reject" &&
      operation !== "reopen"
    ) {
      return getIdentityRuntime().creatorReviewHandlers.decide(request, applicationId);
    }
    return withBusinessOperation(
      { domain: "creator", operation },
      () => getIdentityRuntime().creatorReviewHandlers.decide(request, applicationId),
    );
  });
}
