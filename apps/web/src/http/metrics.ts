import { createHash, timingSafeEqual } from "node:crypto";

type MetricsRegistry = {
  contentType: string;
  metrics(): Promise<string>;
};

export type MetricsDependencies = {
  token: string;
  registry: MetricsRegistry;
};

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export function constantTimeTokenMatches(expected: string, candidate: string): boolean {
  const expectedDigest = tokenDigest(expected);
  const candidateDigest = tokenDigest(candidate);
  return timingSafeEqual(expectedDigest, candidateDigest);
}

function unauthorizedResponse(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "Cache-Control": "no-store" },
  });
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer (.+)$/);
  return match?.[1];
}

export async function createMetricsResponse(
  request: Request,
  dependencies: MetricsDependencies,
): Promise<Response> {
  const candidate = bearerToken(request);
  if (candidate === undefined || !constantTimeTokenMatches(dependencies.token, candidate)) {
    return unauthorizedResponse();
  }

  return new Response(await dependencies.registry.metrics(), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": dependencies.registry.contentType,
    },
  });
}
