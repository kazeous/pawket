import { getIdentityRuntime } from "../../../../../../auth/runtime";
import { withBusinessOperation, withRouteContext } from "../../../../../../http/route-context";

export const runtime = "nodejs";

export function DELETE(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  return withRouteContext(request, async () => {
    const { sessionId } = await context.params;
    return withBusinessOperation(
      { domain: "auth", operation: "session" },
      () => getIdentityRuntime().handlers.session(request, sessionId),
    );
  });
}
