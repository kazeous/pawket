import {
  readBusinessMetricField,
  type RouteContext,
  withBusinessOperation,
  withRouteContext,
} from "../../../../../../http/route-context";
import { getPlatformRuntime } from "../../../../../../platform/runtime";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: RouteContext<"/api/v1/admin/content-reports/[reportId]">,
) {
  const { reportId } = await context.params;
  return withRouteContext(request, async () => {
    const action = await readBusinessMetricField(request, "action");
    const handler = () => getPlatformRuntime().trustHandlers.triage(request, reportId);
    return action === "dismiss" || action === "hide" || action === "restore"
      ? withBusinessOperation(
          { domain: "content_report", operation: action },
          handler,
        )
      : handler();
  });
}
