import { createServer, type Server, type ServerResponse } from "node:http";

import type { RevisionAttestation } from "@pawket/config";
import {
  createProtectedMetricsResponse,
  type PrometheusRegistry,
} from "@pawket/observability/http-metrics";

import { workerReadiness, type WorkerHealthState } from "./worker-health.js";

export type WorkerTelemetryHandle = {
  port: number;
  stop(): Promise<void>;
};

async function writeResponse(target: ServerResponse, source: Response): Promise<void> {
  target.statusCode = source.status;
  source.headers.forEach((value, name) => target.setHeader(name, value));
  target.end(await source.text());
}

function json(body: object, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function startWorkerTelemetryServer(input: {
  port: number;
  token: string;
  registry: PrometheusRegistry;
  revision: RevisionAttestation;
  state: WorkerHealthState;
  host?: string;
  createHttpServer?: typeof createServer;
}): Promise<WorkerTelemetryHandle> {
  const serverFactory = input.createHttpServer ?? createServer;
  const server: Server = serverFactory(async (request, response) => {
    try {
      if (request.method !== "GET") {
        await writeResponse(response, json({ status: "method_not_allowed" }, 405));
        return;
      }

      const path = new URL(request.url ?? "/", "http://worker.internal").pathname;
      if (path === "/health/live") {
        await writeResponse(
          response,
          json({ status: "ok", service: "worker", ...input.revision }),
        );
        return;
      }
      if (path === "/health/ready") {
        const readiness = workerReadiness({ state: input.state, revision: input.revision });
        await writeResponse(
          response,
          json(readiness, readiness.status === "ready" ? 200 : 503),
        );
        return;
      }
      if (path === "/metrics") {
        await writeResponse(
          response,
          await createProtectedMetricsResponse({
            authorization: request.headers.authorization,
            token: input.token,
            registry: input.registry,
          }),
        );
        return;
      }

      await writeResponse(response, json({ status: "not_found" }, 404));
    } catch {
      if (!response.headersSent) {
        await writeResponse(response, json({ status: "internal_error" }, 500));
      } else {
        response.destroy();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(input.port, input.host ?? "0.0.0.0");
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Worker telemetry server failed to expose a TCP port");
  }

  return {
    port: address.port,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
