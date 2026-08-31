import { type RouteContext, withRouteContext } from "../../../../../../http/route-context";
import { getPlatformRuntime } from "../../../../../../platform/runtime";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: RouteContext<"/api/v1/admin/content-reports/[reportId]">,
) {
  const { reportId } = await context.params;
  return withRouteContext(request, () => getPlatformRuntime().trustHandlers.triage(request, reportId));
}
