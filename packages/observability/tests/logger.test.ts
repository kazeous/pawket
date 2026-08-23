import type { ServerEnv } from "@pawket/config";
import type { DestinationStream } from "pino";
import { describe, expect, it } from "vitest";

import {
  createLogger,
  httpRequestDurationSeconds,
  httpRequestsTotal,
  metricsRegistry,
  outboxOldestAgeSeconds,
  outboxPendingTotal,
  workerJobDurationSeconds,
  workerJobsTotal,
  withRequestContext,
} from "../src/index.js";

const testEnv: ServerEnv = {
  NODE_ENV: "test",
  APP_ENV: "test",
  APP_REVISION: "test-revision-123",
  DATABASE_URL: "postgresql://pawket:dummy-database-password@localhost:5432/pawket_test",
  VALKEY_URL: "redis://:dummy-valkey-secret@localhost:6379",
  METRICS_TOKEN: "dummy-metrics-token-123456789012345",
  LOG_LEVEL: "info",
  PORT: 3000,
  WORKER_CONCURRENCY: 10,
  OUTBOX_BATCH_SIZE: 100,
  OUTBOX_LEASE_MS: 30000,
};

describe("createLogger", () => {
  it("serializes service metadata and request context while redacting sensitive values", () => {
    // Catches log records without correlation metadata or with secrets exposed by serialization.
    const records: string[] = [];
    const destination: DestinationStream = {
      write(record) {
        records.push(record);
      },
    };
    const logger = createLogger({ service: "web", env: testEnv, destination });

    withRequestContext(
      {
        requestId: "request-log-123",
        actorId: "actor-log-123",
        orderId: "order-log-123",
        paymentIntentId: "payment-intent-log-123",
        outboxEventId: "outbox-event-log-123",
        jobId: "job-log-123",
      },
      () => {
        logger.info(
          {
            authorization: "Bearer dummy-authorization-value",
            cookie: "session=dummy-cookie-value",
            DATABASE_URL: testEnv.DATABASE_URL,
            VALKEY_URL: testEnv.VALKEY_URL,
            request: {
              authorization: "Bearer dummy-nested-authorization-value",
              cookie: "session=dummy-nested-cookie-value",
            },
            credentials: {
              password: "dummy-password-value",
              secret: "dummy-secret-value",
              token: "dummy-token-value",
            },
          },
          "observability test record",
        );
      },
    );

    expect(records).toHaveLength(1);
    const serializedRecord = records[0];
    expect(serializedRecord).toBeDefined();
    expect(() => JSON.parse(serializedRecord ?? "")).not.toThrow();

    const record = JSON.parse(serializedRecord ?? "") as Record<string, unknown>;
    expect(record).toMatchObject({
      service: "web",
      environment: "test",
      revision: "test-revision-123",
      requestId: "request-log-123",
      actorId: "actor-log-123",
      orderId: "order-log-123",
      paymentIntentId: "payment-intent-log-123",
      outboxEventId: "outbox-event-log-123",
      jobId: "job-log-123",
    });

    for (const sensitiveValue of [
      "dummy-authorization-value",
      "dummy-cookie-value",
      "dummy-database-password",
      "dummy-valkey-secret",
      "dummy-nested-authorization-value",
      "dummy-nested-cookie-value",
      "dummy-password-value",
      "dummy-secret-value",
      "dummy-token-value",
    ]) {
      expect(serializedRecord).not.toContain(sensitiveValue);
    }

    expect(JSON.stringify(record)).toContain("[Redacted]");
  });

  it("preserves installed correlation context when a log payload spoofs an ID", () => {
    // Catches Pino mutating the installed store or letting a caller override correlation metadata.
    const records: string[] = [];
    const destination: DestinationStream = {
      write(record) {
        records.push(record);
      },
    };
    const logger = createLogger({ service: "worker", env: testEnv, destination });
    const context = { requestId: "request-authentic", actorId: "actor-authentic" };

    withRequestContext(context, () => {
      logger.info({ requestId: "request-spoofed", actorId: "actor-spoofed" }, "spoof attempt");
      expect(context).toEqual({ requestId: "request-authentic", actorId: "actor-authentic" });
    });

    expect(JSON.parse(records[0] ?? "")).toMatchObject({
      requestId: "request-authentic",
      actorId: "actor-authentic",
    });
  });

  it("redacts nested and case-variant secrets plus raw request bodies without mutating input", () => {
    // Catches shallow, case-sensitive redaction and sanitizers that alter caller-owned payloads.
    const records: string[] = [];
    const destination: DestinationStream = {
      write(record) {
        records.push(record);
      },
    };
    const logger = createLogger({ service: "web", env: testEnv, destination });
    const payload = {
      credentials: {
        nested: {
          token: "dummy-deep-token-value",
        },
      },
      headers: {
        Authorization: "Bearer dummy-case-authorization-value",
      },
      request: {
        body: {
          detail: "dummy-request-body-value",
        },
      },
      req: {
        body: "dummy-raw-request-body-value",
      },
    };

    logger.info(payload, "deep redaction test record");

    expect(payload).toEqual({
      credentials: {
        nested: {
          token: "dummy-deep-token-value",
        },
      },
      headers: {
        Authorization: "Bearer dummy-case-authorization-value",
      },
      request: {
        body: {
          detail: "dummy-request-body-value",
        },
      },
      req: {
        body: "dummy-raw-request-body-value",
      },
    });

    const serializedRecord = records[0] ?? "";
    expect(() => JSON.parse(serializedRecord)).not.toThrow();
    for (const sensitiveValue of [
      "dummy-deep-token-value",
      "dummy-case-authorization-value",
      "dummy-request-body-value",
      "dummy-raw-request-body-value",
    ]) {
      expect(serializedRecord).not.toContain(sensitiveValue);
    }
    expect(serializedRecord).toContain("[Redacted]");
  });
});

describe("operational metrics", () => {
  it("registers bounded-label HTTP, outbox, and worker metrics", async () => {
    // Catches missing metrics or an added required high-cardinality correlation label.
    metricsRegistry.resetMetrics();
    const httpLabels = {
      method: "GET",
      route: "/creator/:handle",
      status_code: "200",
    };
    const workerLabels = {
      queue: "outbox",
      name: "publish-event",
      outcome: "completed",
    };

    httpRequestsTotal.inc(httpLabels);
    httpRequestDurationSeconds.observe(httpLabels, 0.125);
    outboxPendingTotal.set(3);
    outboxOldestAgeSeconds.set(42);
    workerJobsTotal.inc(workerLabels);
    workerJobDurationSeconds.observe(workerLabels, 0.25);

    const serializedMetrics = await metricsRegistry.metrics();
    expect(serializedMetrics).toContain(
      'pawket_http_requests_total{method="GET",route="/creator/:handle",status_code="200"} 1',
    );
    expect(serializedMetrics).toContain("pawket_http_request_duration_seconds_sum");
    expect(serializedMetrics).toContain("pawket_outbox_pending_total 3");
    expect(serializedMetrics).toContain("pawket_outbox_oldest_age_seconds 42");
    expect(serializedMetrics).toContain(
      'pawket_worker_jobs_total{queue="outbox",name="publish-event",outcome="completed"} 1',
    );
    expect(serializedMetrics).toContain("pawket_worker_job_duration_seconds_sum");
    expect(serializedMetrics).not.toContain("actor-demo");
  });
});
