import { getPlatformRuntime } from "../../../../../../platform/runtime";
import { withRouteContext, type RouteContext } from "../../../../../../http/route-context";

export const runtime = "nodejs";
type Context = RouteContext<"/api/v1/auth/commands/[id]">;
export function GET(request: Request, context: Context) {
  return withRouteContext(request, async () => getPlatformRuntime().pendingCommands.review(request, (await context.params).id));
}
export function POST(request: Request, context: Context) {
  return withRouteContext(request, async () => getPlatformRuntime().pendingCommands.confirm(request, (await context.params).id));
}
export function DELETE(request: Request, context: Context) {
  return withRouteContext(request, async () => getPlatformRuntime().pendingCommands.cancel(request, (await context.params).id));
}
