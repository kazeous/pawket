import {
  type RouteContext,
  withBusinessOperation,
  withRouteContext,
} from "../../../../../../../../http/route-context";
import { getPlatformRuntime } from "../../../../../../../../platform/runtime";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: RouteContext<"/api/v1/creator-page/media/uploads/[intentId]/complete">,
) {
  const { intentId } = await context.params;
  return withRouteContext(request, () =>
    withBusinessOperation(
      { domain: "public_media", operation: "upload" },
      () => getPlatformRuntime().mediaCommandHandlers.completeUpload(request, intentId),
    ),
  );
}
