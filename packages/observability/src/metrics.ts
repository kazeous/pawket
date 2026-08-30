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

const authOperationsTotal = new Counter({
  name: "pawket_auth_operations_total",
  help: "Authentication operations by closed operation and outcome.",
  labelNames: ["operation", "outcome"],
  registers: [metricsRegistry],
});

const creatorOperationsTotal = new Counter({
  name: "pawket_creator_operations_total",
  help: "Creator operations by closed operation and outcome.",
  labelNames: ["operation", "outcome"],
  registers: [metricsRegistry],
});

const receivingProofOperationsTotal = new Counter({
  name: "pawket_receiving_proof_operations_total",
  help: "Receiving-account proof operations by closed operation and outcome.",
  labelNames: ["operation", "outcome"],
  registers: [metricsRegistry],
});

const refundOperationsTotal = new Counter({
  name: "pawket_refund_operations_total",
  help: "Refund operations by closed operation and outcome.",
  labelNames: ["operation", "outcome"],
  registers: [metricsRegistry],
});

const securityEmailsTotal = new Counter({
  name: "pawket_security_emails_total",
  help: "Security and operational email handoff outcomes by bounded purpose.",
  labelNames: ["purpose", "outcome"],
  registers: [metricsRegistry],
});

const securityEmailPendingTotal = new Gauge({
  name: "pawket_security_email_pending_total",
  help: "Current number of security and operational email handoffs awaiting delivery.",
  registers: [metricsRegistry],
});

const securityEmailOldestAgeSeconds = new Gauge({
  name: "pawket_security_email_oldest_age_seconds",
  help: "Age of the oldest security or operational email awaiting delivery in seconds.",
  registers: [metricsRegistry],
});

const securityEmailAttentionTotal = new Gauge({
  name: "pawket_security_email_attention_total",
  help: "Current number of email handoffs requiring operator attention.",
  registers: [metricsRegistry],
});

const workerLastSuccessTimestampSeconds = new Gauge({
  name: "pawket_worker_last_success_timestamp_seconds",
  help: "Unix timestamp of the last successful bounded worker scan.",
  labelNames: ["scan"],
  registers: [metricsRegistry],
});

const workerScanHealthy = new Gauge({
  name: "pawket_worker_scan_healthy",
  help: "Whether the most recent configured worker scan completed successfully.",
  labelNames: ["scan"],
  registers: [metricsRegistry],
});

const publicMediaCleanupOldestEligibleTimestampSeconds = new Gauge({
  name: "pawket_public_media_cleanup_oldest_eligible_timestamp_seconds",
  help: "Unix timestamp of the oldest public-media cleanup candidate, or zero when none are eligible.",
  registers: [metricsRegistry],
});

const retentionRecordsTotal = new Counter({
  name: "pawket_retention_records_total",
  help: "Retention scan results by closed dataset, mode, and disposition.",
  labelNames: ["dataset", "mode", "disposition"],
  registers: [metricsRegistry],
});

const authAbuseControlsTotal = new Counter({
  name: "pawket_auth_abuse_controls_total",
  help: "Authentication abuse-control activations without identity labels.",
  labelNames: ["control"],
  registers: [metricsRegistry],
});

const revisionMatch = new Gauge({
  name: "pawket_revision_match",
  help: "Whether runtime and embedded build revisions match exactly.",
  labelNames: ["service"],
  registers: [metricsRegistry],
});

const allowedHttpMethods = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);
const allowedHttpRoutes = new Set([
  "/",
  "/api/health/live",
  "/api/health/ready",
  "/api/metrics",
  "/api/auth",
  "/api/v1/admin",
  "/api/v1/auth",
  "/api/v1/creator",
  "/api/v1/me",
  "unmatched",
]);
const allowedWorkerJobNames = new Set(["system.outbox-event", "unsupported"]);
const allowedAuthOperations = new Set([
  "registration",
  "verification",
  "login",
  "oauth_callback",
  "reset",
  "mfa",
  "session",
  "security_change",
]);
const allowedCreatorOperations = new Set([
  "draft",
  "submit",
  "withdraw",
  "changes_requested",
  "approve",
  "reject",
  "reopen",
  "suspend",
  "reinstate",
]);
const allowedReceivingProofOperations = new Set([
  "challenge",
  "report",
  "matched",
  "unmatched",
]);
const allowedRefundOperations = new Set([
  "window",
  "sent",
  "attention_required",
]);
const allowedSharedOutcomes = new Set([
  "succeeded",
  "rejected",
  "retryable_failure",
  "attention_required",
]);
const allowedStandardOperationOutcomes = new Set([
  "succeeded",
  "rejected",
  "retryable_failure",
]);
const allowedReceivingProofOutcomes = new Map<string, ReadonlySet<string>>([
  ["challenge", allowedStandardOperationOutcomes],
  ["report", allowedStandardOperationOutcomes],
  ["matched", new Set(["succeeded"])],
  ["unmatched", new Set(["succeeded"])],
]);
const allowedRefundOutcomes = new Map<string, ReadonlySet<string>>([
  ["window", new Set(["succeeded", "retryable_failure"])],
  ["sent", allowedStandardOperationOutcomes],
  ["attention_required", new Set(["attention_required", "rejected", "retryable_failure"])],
]);
const allowedEmailPurposes = new Set([
  "application_outcome",
  "creator_status",
  "email_change",
  "email_verification",
  "password_reset",
  "refund_status",
  "security_notice",
]);
const allowedEmailOutcomes = new Set([
  "attention_required",
  "queued",
  "retryable_failure",
  "sent",
]);
const allowedWorkerScans = new Set(["outbox", "public_media_cleanup", "refund", "retention"]);
const allowedRetentionDatasets = new Set([
  "application_content",
  "failed_quarantine",
  "processed_source",
  "provisional_accounts",
  "ready_unreferenced",
  "receiving_accounts",
  "security_throttles",
  "sessions",
  "superseded_derivative",
  "verifications",
]);
const allowedRetentionModes = new Set(["enforce", "report_only"]);
const allowedRetentionDispositions = new Set(["candidate", "failed", "processed", "protected"]);
const allowedAuthAbuseControls = new Set(["password_sign_in"]);
const allowedServices = new Set(["web", "worker"]);

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
  attention: number;
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
    !Number.isInteger(input.attention) ||
    input.attention < 0 ||
    !Number.isSafeInteger(input.outstandingAmountVnd) ||
    input.outstandingAmountVnd < 0
  ) {
    rejectUnsafeMetric();
  }
  refundLiabilitiesTotal.set({ window: "due_soon" }, input.dueSoon);
  refundLiabilitiesTotal.set({ window: "due_today" }, input.dueToday);
  refundLiabilitiesTotal.set({ window: "overdue" }, input.overdue);
  refundLiabilitiesTotal.set({ window: "attention_required" }, input.attention);
  refundLiabilityOutstandingVnd.set(input.outstandingAmountVnd);
}

function recordClosedOperation(
  counter: Counter,
  input: {
    operation: string;
    outcome: string;
  },
  allowedOperations: ReadonlySet<string>,
  allowedOutcomes: ReadonlySet<string>,
): void {
  assertSafeStructuredData(input, "metric");
  if (
    !allowedOperations.has(input.operation) ||
    !allowedSharedOutcomes.has(input.outcome) ||
    !allowedOutcomes.has(input.outcome)
  ) {
    rejectUnsafeMetric();
  }
  counter.inc(input);
}

export function recordAuthOperation(input: {
  operation: string;
  outcome: string;
}): void {
  recordClosedOperation(
    authOperationsTotal,
    input,
    allowedAuthOperations,
    allowedStandardOperationOutcomes,
  );
}

export function recordCreatorOperation(input: {
  operation: string;
  outcome: string;
}): void {
  recordClosedOperation(
    creatorOperationsTotal,
    input,
    allowedCreatorOperations,
    allowedStandardOperationOutcomes,
  );
}

export function recordReceivingProofOperation(input: {
  operation: string;
  outcome: string;
}): void {
  recordClosedOperation(
    receivingProofOperationsTotal,
    input,
    allowedReceivingProofOperations,
    allowedReceivingProofOutcomes.get(input.operation) ?? new Set(),
  );
}

export function recordRefundOperation(input: {
  operation: string;
  outcome: string;
}): void {
  recordClosedOperation(
    refundOperationsTotal,
    input,
    allowedRefundOperations,
    allowedRefundOutcomes.get(input.operation) ?? new Set(),
  );
}

export function recordSecurityEmailMetrics(input: {
  purpose: string;
  outcome: string;
}): void {
  assertSafeStructuredData(input, "metric");
  if (!allowedEmailPurposes.has(input.purpose) || !allowedEmailOutcomes.has(input.outcome)) {
    rejectUnsafeMetric();
  }
  securityEmailsTotal.inc(input);
}

export function setSecurityEmailBacklogMetrics(input: {
  pending: number;
  oldestAgeSeconds: number;
  attention: number;
}): void {
  assertSafeStructuredData(input, "metric");
  if (
    !Number.isInteger(input.pending) ||
    input.pending < 0 ||
    !Number.isFinite(input.oldestAgeSeconds) ||
    input.oldestAgeSeconds < 0 ||
    !Number.isInteger(input.attention) ||
    input.attention < 0
  ) {
    rejectUnsafeMetric();
  }
  securityEmailPendingTotal.set(input.pending);
  securityEmailOldestAgeSeconds.set(input.oldestAgeSeconds);
  securityEmailAttentionTotal.set(input.attention);
}

export function setWorkerLastSuccessMetric(input: {
  scan: string;
  timestampSeconds: number;
}): void {
  assertSafeStructuredData(input, "metric");
  if (
    !allowedWorkerScans.has(input.scan) ||
    !Number.isFinite(input.timestampSeconds) ||
    input.timestampSeconds < 0
  ) {
    rejectUnsafeMetric();
  }
  workerLastSuccessTimestampSeconds.set({ scan: input.scan }, input.timestampSeconds);
}

export function setWorkerScanHealthMetric(input: {
  scan: string;
  healthy: boolean;
}): void {
  assertSafeStructuredData(input, "metric");
  if (!allowedWorkerScans.has(input.scan) || typeof input.healthy !== "boolean") {
    rejectUnsafeMetric();
  }
  workerScanHealthy.set({ scan: input.scan }, input.healthy ? 1 : 0);
}

export function setPublicMediaCleanupOldestEligibleMetric(input: {
  timestampSeconds: number | null;
}): void {
  assertSafeStructuredData(input, "metric");
  if (
    input.timestampSeconds !== null &&
    (!Number.isFinite(input.timestampSeconds) || input.timestampSeconds < 0)
  ) {
    rejectUnsafeMetric();
  }
  publicMediaCleanupOldestEligibleTimestampSeconds.set(input.timestampSeconds ?? 0);
}

export function recordRetentionMetrics(input: {
  dataset: string;
  mode: string;
  disposition: string;
  count: number;
}): void {
  assertSafeStructuredData(input, "metric");
  if (
    !allowedRetentionDatasets.has(input.dataset) ||
    !allowedRetentionModes.has(input.mode) ||
    !allowedRetentionDispositions.has(input.disposition) ||
    !Number.isInteger(input.count) ||
    input.count < 0
  ) {
    rejectUnsafeMetric();
  }
  if (input.count > 0) {
    retentionRecordsTotal.inc(
      { dataset: input.dataset, mode: input.mode, disposition: input.disposition },
      input.count,
    );
  }
}

export function recordAuthAbuseControl(control: string): void {
  assertSafeStructuredData({ control }, "metric");
  if (!allowedAuthAbuseControls.has(control)) rejectUnsafeMetric();
  authAbuseControlsTotal.inc({ control });
}

export function setRevisionAttestationMetric(input: {
  service: string;
  revisionMatch: boolean;
}): void {
  assertSafeStructuredData(input, "metric");
  if (!allowedServices.has(input.service)) rejectUnsafeMetric();
  revisionMatch.set({ service: input.service }, input.revisionMatch ? 1 : 0);
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
