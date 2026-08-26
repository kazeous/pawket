import { parseServerEnv } from "@pawket/config";
import type { DestinationStream } from "pino";
import { describe, expect, it } from "vitest";

import {
  createLogger,
  metricsRegistry,
  recordAuthAbuseControl,
  recordHttpRequestMetrics,
  recordRetentionMetrics,
  recordSecurityEmailMetrics,
  recordWorkerJobMetrics,
  setOutboxMetrics,
  setRevisionAttestationMetric,
  setRefundLiabilityMetrics,
  setSecurityEmailBacklogMetrics,
  setWorkerLastSuccessMetric,
  withRequestContext,
} from "../src/index.js";
import * as observability from "../src/index.js";

type DomainMetricExports = {
  recordAuthOperation?: (input: { operation: string; outcome: string }) => void;
  recordCreatorOperation?: (input: { operation: string; outcome: string }) => void;
  recordReceivingProofOperation?: (input: { operation: string; outcome: string }) => void;
  recordRefundOperation?: (input: { operation: string; outcome: string }) => void;
  setWorkerScanHealthMetric?: (input: { scan: string; healthy: boolean }) => void;
};

const domainMetrics = observability as DomainMetricExports;

const testEnv = parseServerEnv({
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
});

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

  it("redacts configured secrets even under safe keys and inside the log message", () => {
    const records: string[] = [];
    const destination: DestinationStream = {
      write(record) {
        records.push(record);
      },
    };
    const logger = createLogger({ service: "web", env: testEnv, destination });

    logger.info(
      { note: `lookup=${testEnv.PII_LOOKUP_HMAC_KEY}` },
      `destination=${testEnv.OPERATING_BANK_ACCOUNT_NUMBER}`,
    );

    const serializedRecord = records[0] ?? "";
    expect(serializedRecord).not.toContain(testEnv.PII_LOOKUP_HMAC_KEY);
    expect(serializedRecord).not.toContain(testEnv.OPERATING_BANK_ACCOUNT_NUMBER);
    expect(serializedRecord).toContain("[Redacted]");
  });
});

describe("operational metrics", () => {
  it("registers bounded-label HTTP, outbox, and worker metrics", async () => {
    // Catches missing metrics or an added required high-cardinality correlation label.
    metricsRegistry.resetMetrics();
    recordHttpRequestMetrics({
      method: "GET",
      route: "/api/health/ready",
      statusCode: 200,
      durationSeconds: 0.125,
    });
    setOutboxMetrics({ pending: 3, oldestAgeSeconds: 42 });
    setRefundLiabilityMetrics({
      dueSoon: 2,
      dueToday: 1,
      overdue: 3,
      attention: 1,
      outstandingAmountVnd: 60_000,
    });
    recordWorkerJobMetrics({
      name: "system.outbox-event",
      outcome: "completed",
      durationSeconds: 0.25,
    });
    expect(domainMetrics.recordAuthOperation).toEqual(expect.any(Function));
    expect(domainMetrics.recordCreatorOperation).toEqual(expect.any(Function));
    expect(domainMetrics.recordReceivingProofOperation).toEqual(expect.any(Function));
    expect(domainMetrics.recordRefundOperation).toEqual(expect.any(Function));
    expect(domainMetrics.setWorkerScanHealthMetric).toEqual(expect.any(Function));
    domainMetrics.recordAuthOperation?.({ operation: "login", outcome: "succeeded" });
    domainMetrics.recordCreatorOperation?.({ operation: "submit", outcome: "rejected" });
    domainMetrics.recordReceivingProofOperation?.({
      operation: "matched",
      outcome: "succeeded",
    });
    domainMetrics.recordRefundOperation?.({
      operation: "attention_required",
      outcome: "attention_required",
    });
    recordSecurityEmailMetrics({ purpose: "refund_status", outcome: "queued" });
    setSecurityEmailBacklogMetrics({ pending: 4, oldestAgeSeconds: 90, attention: 1 });
    setWorkerLastSuccessMetric({ scan: "retention", timestampSeconds: 1_787_671_200 });
    domainMetrics.setWorkerScanHealthMetric?.({ scan: "retention", healthy: false });
    recordRetentionMetrics({
      dataset: "application_content",
      mode: "report_only",
      disposition: "protected",
      count: 2,
    });
    recordAuthAbuseControl("password_sign_in");
    setRevisionAttestationMetric({ service: "worker", revisionMatch: true });

    const serializedMetrics = await metricsRegistry.metrics();
    expect(serializedMetrics).toContain(
      'pawket_http_requests_total{method="GET",route="/api/health/ready",status_code="200"} 1',
    );
    expect(serializedMetrics).toContain("pawket_http_request_duration_seconds_sum");
    expect(serializedMetrics).toContain("pawket_outbox_pending_total 3");
    expect(serializedMetrics).toContain("pawket_outbox_oldest_age_seconds 42");
    expect(serializedMetrics).toContain('pawket_refund_liabilities_total{window="due_soon"} 2');
    expect(serializedMetrics).toContain('pawket_refund_liabilities_total{window="due_today"} 1');
    expect(serializedMetrics).toContain('pawket_refund_liabilities_total{window="overdue"} 3');
    expect(serializedMetrics).toContain('pawket_refund_liabilities_total{window="attention_required"} 1');
    expect(serializedMetrics).toContain("pawket_refund_liability_outstanding_vnd 60000");
    expect(serializedMetrics).toContain(
      'pawket_worker_jobs_total{queue="pawket.system",name="system.outbox-event",outcome="completed"} 1',
    );
    expect(serializedMetrics).toContain("pawket_worker_job_duration_seconds_sum");
    expect(serializedMetrics).not.toContain("pawket_operational_outcomes_total");
    expect(serializedMetrics).toContain(
      'pawket_auth_operations_total{operation="login",outcome="succeeded"} 1',
    );
    expect(serializedMetrics).toContain(
      'pawket_creator_operations_total{operation="submit",outcome="rejected"} 1',
    );
    expect(serializedMetrics).toContain(
      'pawket_receiving_proof_operations_total{operation="matched",outcome="succeeded"} 1',
    );
    expect(serializedMetrics).toContain(
      'pawket_refund_operations_total{operation="attention_required",outcome="attention_required"} 1',
    );
    expect(serializedMetrics).toContain(
      'pawket_security_emails_total{purpose="refund_status",outcome="queued"} 1',
    );
    expect(serializedMetrics).toContain("pawket_security_email_pending_total 4");
    expect(serializedMetrics).toContain("pawket_security_email_oldest_age_seconds 90");
    expect(serializedMetrics).toContain("pawket_security_email_attention_total 1");
    expect(serializedMetrics).toContain(
      'pawket_worker_last_success_timestamp_seconds{scan="retention"} 1787671200',
    );
    expect(serializedMetrics).toContain(
      'pawket_worker_scan_healthy{scan="retention"} 0',
    );
    expect(serializedMetrics).toContain(
      'pawket_retention_records_total{dataset="application_content",mode="report_only",disposition="protected"} 2',
    );
    expect(serializedMetrics).toContain(
      'pawket_auth_abuse_controls_total{control="password_sign_in"} 1',
    );
    expect(serializedMetrics).toContain('pawket_revision_match{service="worker"} 1');
    expect(serializedMetrics).not.toContain("actor-demo");
  });

  it("rejects unbounded or sensitive metric labels before Prometheus observes them", async () => {
    metricsRegistry.resetMetrics();
    expect(() =>
      recordHttpRequestMetrics({
        method: "GET",
        route: "/creator/private-account-number",
        statusCode: 200,
        durationSeconds: 0.1,
      }),
    ).toThrow("Unsafe metric data");
    expect(() =>
      recordWorkerJobMetrics({
        name: "system.outbox-event",
        outcome: "completed",
        durationSeconds: Number.NaN,
      }),
    ).toThrow("Unsafe metric data");
    expect(() => recordAuthAbuseControl("artist@example.test")).toThrow("Unsafe metric data");
    expect(() =>
      domainMetrics.recordAuthOperation?.({
        operation: "artist@example.test",
        outcome: "succeeded",
      }),
    ).toThrow("Unsafe metric data");
    expect(() =>
      domainMetrics.recordCreatorOperation?.({ operation: "submit", outcome: "success" }),
    ).toThrow("Unsafe metric data");
    expect(() =>
      domainMetrics.recordRefundOperation?.({
        operation: "sent",
        outcome: "attention_required",
      }),
    ).toThrow("Unsafe metric data");
    expect(() =>
      recordSecurityEmailMetrics({ purpose: "password_reset", outcome: "failed" }),
    ).toThrow("Unsafe metric data");
    expect(await metricsRegistry.metrics()).not.toContain("private-account-number");
  });

  it("accepts every closed operation and email outcome without creating extra labels", async () => {
    // Catches taxonomy drift, missing declared operations, or a generic high-cardinality label.
    metricsRegistry.resetMetrics();
    for (const operation of [
      "registration",
      "verification",
      "login",
      "oauth_callback",
      "reset",
      "mfa",
      "session",
      "security_change",
    ]) {
      domainMetrics.recordAuthOperation?.({ operation, outcome: "succeeded" });
    }
    for (const operation of [
      "draft",
      "submit",
      "withdraw",
      "changes_requested",
      "approve",
      "reject",
      "reopen",
      "suspend",
      "reinstate",
    ]) {
      domainMetrics.recordCreatorOperation?.({ operation, outcome: "succeeded" });
    }
    for (const operation of ["challenge", "report", "matched", "unmatched"]) {
      domainMetrics.recordReceivingProofOperation?.({ operation, outcome: "succeeded" });
    }
    domainMetrics.recordRefundOperation?.({ operation: "window", outcome: "succeeded" });
    domainMetrics.recordRefundOperation?.({ operation: "sent", outcome: "succeeded" });
    domainMetrics.recordRefundOperation?.({
      operation: "attention_required",
      outcome: "attention_required",
    });
    for (const outcome of [
      "queued",
      "sent",
      "retryable_failure",
      "attention_required",
    ]) {
      recordSecurityEmailMetrics({ purpose: "security_notice", outcome });
    }

    const serializedMetrics = await metricsRegistry.metrics();
    for (const operation of [
      "registration",
      "verification",
      "login",
      "oauth_callback",
      "reset",
      "mfa",
      "session",
      "security_change",
    ]) {
      expect(serializedMetrics).toContain(
        `pawket_auth_operations_total{operation="${operation}",outcome="succeeded"} 1`,
      );
    }
    expect(serializedMetrics).not.toMatch(/area=|client_error|server_error|outcome="success"/u);
    expect(serializedMetrics).not.toMatch(/email=|user_id|request_id|account=|subject=/u);
  });

  it("accepts only the meaningful outcome pairs for every domain operation", () => {
    // Catches broad domain outcome sets admitting impossible operation/outcome pairs.
    const outcomes = [
      "succeeded",
      "rejected",
      "retryable_failure",
      "attention_required",
    ] as const;
    const standardOutcomes = new Set(["succeeded", "rejected", "retryable_failure"]);
    const cases = [
      {
        record: domainMetrics.recordAuthOperation!,
        operations: [
          "registration",
          "verification",
          "login",
          "oauth_callback",
          "reset",
          "mfa",
          "session",
          "security_change",
        ],
        allowed: () => standardOutcomes,
      },
      {
        record: domainMetrics.recordCreatorOperation!,
        operations: [
          "draft",
          "submit",
          "withdraw",
          "changes_requested",
          "approve",
          "reject",
          "reopen",
          "suspend",
          "reinstate",
        ],
        allowed: () => standardOutcomes,
      },
      {
        record: domainMetrics.recordReceivingProofOperation!,
        operations: ["challenge", "report", "matched", "unmatched"],
        allowed: (operation: string) =>
          new Set(
            operation === "matched" || operation === "unmatched"
              ? ["succeeded"]
              : ["succeeded", "rejected", "retryable_failure"],
          ),
      },
      {
        record: domainMetrics.recordRefundOperation!,
        operations: ["window", "sent", "attention_required"],
        allowed: (operation: string) =>
          new Set(
            operation === "window"
              ? ["succeeded", "retryable_failure"]
              : operation === "sent"
                ? ["succeeded", "rejected", "retryable_failure"]
                : ["attention_required", "rejected", "retryable_failure"],
          ),
      },
    ] as const;

    for (const domain of cases) {
      for (const operation of domain.operations) {
        const allowed = domain.allowed(operation);
        for (const outcome of outcomes) {
          const invoke = () => domain.record({ operation, outcome });
          if (allowed.has(outcome)) {
            expect(invoke, `${operation}/${outcome}`).not.toThrow();
          } else {
            expect(invoke, `${operation}/${outcome}`).toThrow("Unsafe metric data");
          }
        }
      }
    }

    for (const record of cases.map((entry) => entry.record)) {
      expect(() => record({ operation: "unknown", outcome: "succeeded" })).toThrow(
        "Unsafe metric data",
      );
      expect(() => record({ operation: "login", outcome: "unknown" })).toThrow(
        "Unsafe metric data",
      );
    }
  });
});
