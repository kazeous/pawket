import { createLivenessResponse } from "../../../../http/readiness";
import { withRouteContext } from "../../../../http/route-context";

export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return withRouteContext(request, () =>
    createLivenessResponse(process.env.APP_REVISION?.trim() || "unknown"),
  );
}
