import { createHash, timingSafeEqual } from "node:crypto";

export type PrometheusRegistry = {
  contentType: string;
  metrics(): Promise<string>;
};

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export function constantTimeTokenMatches(expected: string, candidate: string): boolean {
  return timingSafeEqual(tokenDigest(expected), tokenDigest(candidate));
}

function bearerToken(authorization: string | null | undefined): string | undefined {
  return authorization?.match(/^Bearer (.+)$/u)?.[1];
}

export async function createProtectedMetricsResponse(input: {
  authorization: string | null | undefined;
  token: string;
  registry: PrometheusRegistry;
}): Promise<Response> {
  const candidate = bearerToken(input.authorization);
  if (candidate === undefined || !constantTimeTokenMatches(input.token, candidate)) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }

  return new Response(await input.registry.metrics(), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": input.registry.contentType,
    },
  });
}
