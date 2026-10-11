import { withCommissionRoute } from "@/http/commission-route";
import { getPlatformRuntime } from "@/platform/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ penaltyId: string }> }) {
  return withCommissionRoute(request, async () => {
    const { penaltyId } = await context.params;
    return getPlatformRuntime().resolutionHandlers.acknowledgeWarning(request, penaltyId);
  });
}
