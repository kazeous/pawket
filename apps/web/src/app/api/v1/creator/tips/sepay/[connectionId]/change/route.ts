import { withTipRoute } from "@/http/tip-route";
import { getPlatformRuntime } from "@/platform/runtime";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ connectionId: string }> }) {
  const { connectionId } = await context.params;
  return withTipRoute(request, () => getPlatformRuntime().sepayHandlers.change(request, connectionId));
}
