import { createLivenessResponse } from "../../../../http/readiness";
import { withRouteContext } from "../../../../http/route-context";

export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return withRouteContext(request, () =>
    createLivenessResponse(
      resolveRevisionAttestation(process.env.APP_REVISION, process.env.APP_BUILD_REVISION),
    ),
  );
}
import { resolveRevisionAttestation } from "@pawket/config";
