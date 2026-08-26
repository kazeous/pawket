import { loadServerEnv, resolveRevisionAttestation } from "@pawket/config";
import {
  metricsRegistry,
  setRevisionAttestationMetric,
} from "@pawket/observability/metrics";

import { createMetricsResponse } from "../../../http/metrics";
import { withRouteContext } from "../../../http/route-context";

export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return withRouteContext(request, () => {
    const env = loadServerEnv();
    const revision = resolveRevisionAttestation(env.APP_REVISION, env.APP_BUILD_REVISION);
    setRevisionAttestationMetric({ service: "web", revisionMatch: revision.revisionMatch });
    return createMetricsResponse(request, {
      token: env.METRICS_TOKEN,
      registry: metricsRegistry,
    });
  });
}
