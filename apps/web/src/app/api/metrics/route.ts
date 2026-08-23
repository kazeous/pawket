import { loadServerEnv } from "@pawket/config";
import { metricsRegistry } from "@pawket/observability/metrics";

import { createMetricsResponse } from "../../../http/metrics";
import { withRouteContext } from "../../../http/route-context";

export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return withRouteContext(request, () =>
    createMetricsResponse(request, {
      token: loadServerEnv().METRICS_TOKEN,
      registry: metricsRegistry,
    }),
  );
}
