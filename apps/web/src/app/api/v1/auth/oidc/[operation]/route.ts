import { getIdentityRuntime } from "../../../../../../auth/runtime";
import { withRouteContext, type RouteContext } from "../../../../../../http/route-context";

export const runtime = "nodejs";
async function handle(request: Request, context: RouteContext<"/api/v1/auth/oidc/[operation]">) {
  const { operation } = await context.params;
  return withRouteContext(request, () => {
    const identity = getIdentityRuntime();
    switch (operation) {
      case "start": return identity.oidc.login(request);
      case "lease": return identity.oidc.lease(request);
      case "step-up": return identity.oidc.stepUp(request);
      case "owner-link": return identity.oidc.ownerLink(request);
      case "callback": return identity.oidc.callback(request);
      case "backchannel-logout": return identity.oidc.backchannelLogout(request);
      case "logout": return identity.handlers.logout(request);
      default: return Response.json({ code: "NOT_FOUND" }, { status: 404, headers: { "cache-control": "no-store" } });
    }
  });
}
export const GET = handle;
export const POST = handle;
