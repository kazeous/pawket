import {
  constantTimeTokenMatches,
  createProtectedMetricsResponse,
} from "@pawket/observability/http-metrics";

type MetricsRegistry = {
  contentType: string;
  metrics(): Promise<string>;
};

export type MetricsDependencies = {
  token: string;
  registry: MetricsRegistry;
};

export { constantTimeTokenMatches };

export async function createMetricsResponse(
  request: Request,
  dependencies: MetricsDependencies,
): Promise<Response> {
  return createProtectedMetricsResponse({
    authorization: request.headers.get("authorization"),
    token: dependencies.token,
    registry: dependencies.registry,
  });
}
