import { Counter, Gauge, Histogram, Registry } from "prom-client";

import {
  assertSafeStructuredData,
  UnsafeStructuredDataError,
} from "@pawket/security/structured-data";

export const metricsRegistry = new Registry();

const httpRequestsTotal = new Counter({
  name: "pawket_http_requests_total",
  help: "Total HTTP requests handled by Pawket.",
  labelNames: ["method", "route", "status_code"],
  registers: [metricsRegistry],
});

const httpRequestDurationSeconds = new Histogram({
  name: "pawket_http_request_duration_seconds",
  help: "Duration of HTTP requests handled by Pawket in seconds.",
  labelNames: ["method", "route", "status_code"],
  registers: [metricsRegistry],
});

const outboxPendingTotal = new Gauge({
  name: "pawket_outbox_pending_total",
  help: "Current number of pending outbox events.",
  registers: [metricsRegistry],
});

const outboxOldestAgeSeconds = new Gauge({
  name: "pawket_outbox_oldest_age_seconds",
  help: "Age of the oldest pending outbox event in seconds.",
  registers: [metricsRegistry],
});

const refundLiabilitiesTotal = new Gauge({
  name: "pawket_refund_liabilities_total",
  help: "Current verification-deposit refund liabilities by bounded due window.",
  labelNames: ["window"],
  registers: [metricsRegistry],
});

const refundLiabilityOutstandingVnd = new Gauge({
  name: "pawket_refund_liability_outstanding_vnd",
  help: "Total VND outstanding across verification-deposit refund liabilities.",
  registers: [metricsRegistry],
});

const workerJobsTotal = new Counter({
  name: "pawket_worker_jobs_total",
  help: "Total worker jobs processed by Pawket.",
  labelNames: ["queue", "name", "outcome"],
  registers: [metricsRegistry],
});

const workerJobDurationSeconds = new Histogram({
  name: "pawket_worker_job_duration_seconds",
  help: "Duration of worker jobs processed by Pawket in seconds.",
  labelNames: ["queue", "name", "outcome"],
  registers: [metricsRegistry],
});

const allowedHttpMethods = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);
const allowedHttpRoutes = new Set([
  "/",
  "/api/health/live",
  "/api/health/ready",
  "/api/metrics",
  "unmatched",
]);
const allowedWorkerJobNames = new Set(["system.outbox-event", "unsupported"]);

function rejectUnsafeMetric(): never {
  throw new UnsafeStructuredDataError("metric");
}

export function recordHttpRequestMetrics(input: {
  method: string;
  route: string;
  statusCode: number;
  durationSeconds: number;
}): void {
  assertSafeStructuredData(input, "metric");
  if (
    !allowedHttpMethods.has(input.method) ||
    !allowedHttpRoutes.has(input.route) ||
    !Number.isInteger(input.statusCode) ||
    input.statusCode < 100 ||
    input.statusCode > 599 ||
    !Number.isFinite(input.durationSeconds) ||
    input.durationSeconds < 0
  ) {
    rejectUnsafeMetric();
  }

  const labels = {
    method: input.method,
    route: input.route,
    status_code: String(input.statusCode),
  };
  httpRequestsTotal.inc(labels);
  httpRequestDurationSeconds.observe(labels, input.durationSeconds);
}

export function setOutboxMetrics(input: {
  pending: number;
  oldestAgeSeconds: number;
}): void {
  assertSafeStructuredData(input, "metric");
  if (
    !Number.isInteger(input.pending) ||
    input.pending < 0 ||
    !Number.isFinite(input.oldestAgeSeconds) ||
    input.oldestAgeSeconds < 0
  ) {
    rejectUnsafeMetric();
  }
  outboxPendingTotal.set(input.pending);
  outboxOldestAgeSeconds.set(input.oldestAgeSeconds);
}

export function setRefundLiabilityMetrics(input: {
  dueSoon: number;
  dueToday: number;
  overdue: number;
  outstandingAmountVnd: number;
}): void {
  assertSafeStructuredData(input, "metric");
  if (
    !Number.isInteger(input.dueSoon) ||
    input.dueSoon < 0 ||
    !Number.isInteger(input.dueToday) ||
    input.dueToday < 0 ||
    !Number.isInteger(input.overdue) ||
    input.overdue < 0 ||
    !Number.isSafeInteger(input.outstandingAmountVnd) ||
    input.outstandingAmountVnd < 0
  ) {
    rejectUnsafeMetric();
  }
  refundLiabilitiesTotal.set({ window: "due_soon" }, input.dueSoon);
  refundLiabilitiesTotal.set({ window: "due_today" }, input.dueToday);
  refundLiabilitiesTotal.set({ window: "overdue" }, input.overdue);
  refundLiabilityOutstandingVnd.set(input.outstandingAmountVnd);
}

export function recordWorkerJobMetrics(input: {
  name: "system.outbox-event" | "unsupported";
  outcome: "completed" | "failed";
  durationSeconds: number;
}): void {
  assertSafeStructuredData(input, "metric");
  if (
    !allowedWorkerJobNames.has(input.name) ||
    !Number.isFinite(input.durationSeconds) ||
    input.durationSeconds < 0
  ) {
    rejectUnsafeMetric();
  }
  const labels = { queue: "pawket.system", name: input.name, outcome: input.outcome };
  workerJobsTotal.inc(labels);
  workerJobDurationSeconds.observe(labels, input.durationSeconds);
}
