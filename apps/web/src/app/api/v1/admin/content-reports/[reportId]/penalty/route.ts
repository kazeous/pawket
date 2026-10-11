import { withCommissionRoute } from "../../../../../../../http/commission-route";
import { getPlatformRuntime } from "../../../../../../../platform/runtime";
import type { RouteContext } from "../../../../../../../http/route-context";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request, context: RouteContext<"/api/v1/admin/content-reports/[reportId]/penalty">) {
  return withCommissionRoute(request, async () => getPlatformRuntime().caseHandlers.publicReportParties(request, (await context.params).reportId));
}
export function POST(request: Request, context: RouteContext<"/api/v1/admin/content-reports/[reportId]/penalty">) {
  return withCommissionRoute(request, async () => getPlatformRuntime().caseHandlers.publicReportPenalty(request, (await context.params).reportId));
}
