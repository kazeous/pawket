import { withCommissionRoute } from "../../../../../../../../http/commission-route";
import { getPlatformRuntime } from "../../../../../../../../platform/runtime";
import type { RouteContext } from "../../../../../../../../http/route-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request, context: RouteContext<"/api/v1/admin/cases/[caseId]/files/[fileId]">) {
  return withCommissionRoute(request, async () => {
    const params = await context.params;
    return getPlatformRuntime().caseHandlers.file(request, params.caseId, params.fileId);
  });
}
