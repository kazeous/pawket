import { loadServerEnv } from "@pawket/config";

import { createLivenessResponse } from "../../../../http/readiness";
import { withRouteContext } from "../../../../http/route-context";

export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return withRouteContext(request, () => createLivenessResponse(loadServerEnv().APP_REVISION));
}
