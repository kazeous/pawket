import { Counter, Gauge, Histogram, Registry } from "prom-client";

import {
  assertSafeStructuredData,
  UnsafeStructuredDataError,
} from "@pawket/security/structured-data";

export const metricsRegistry = new Registry();

const commissionOperationsTotal = new Counter({ name: "pawket_commission_operations_total", help: "Commission operations by fixed operation and outcome, without private order or payment fields.", labelNames: ["operation", "outcome"], registers: [metricsRegistry] });
const commissionOutcomes: Readonly<Record<string, readonly string[]>> = {
  cleanup: ["completed", "expired", "invalidated", "deferred", "failed"],
  request: ["accepted", "replayed", "capacity_full", "rejected", "rate_limited", "disabled", "failed"],
  command: ["accepted", "replayed", "version_conflict", "rejected", "rate_limited", "disabled", "failed"],
  confirm: ["creator_manual", "sepay_automatic", "creator_reviewed_sepay", "replayed", "conflict", "rejected", "failed"],
  event: ["validated", "failed"],
};
const commissionCleanupConfigured = new Gauge({ name: "pawket_commission_cleanup_configured", help: "Commission cleanup is configured independently of intake and payment pauses.", registers: [metricsRegistry] });
const commissionOrdersCurrent = new Gauge({ name: "pawket_commission_orders_current", help: "Current commission orders by fixed lifecycle state.", labelNames: ["state"], registers: [metricsRegistry] });
const commissionExpiryBacklog = new Gauge({ name: "pawket_commission_expiry_backlog", help: "Commission orders past their closing deadline by fixed state.", labelNames: ["state"], registers: [metricsRegistry] });
const commissionExpiryLag = new Gauge({ name: "pawket_commission_expiry_oldest_lag_seconds", help: "Seconds since the oldest pending commission closing deadline.", registers: [metricsRegistry] });
const commissionOverdue = new Gauge({ name: "pawket_commission_overdue_orders", help: "Paid commission orders past their immutable delivery deadline; not proof of delivery failure.", registers: [metricsRegistry] });
const commissionRetentionInventory = new Gauge({ name: "pawket_commission_retention_inventory", help: "Protected commission retention inventory. Report only; no deletion policy is authorized.", labelNames: ["dataset"], registers: [metricsRegistry] });
export function setCommissionCleanupConfiguredMetric(configured: boolean): void {
  if (typeof configured !== "boolean") rejectUnsafeMetric();
  commissionCleanupConfigured.set(configured ? 1 : 0);
}
export function setCommissionOperationalMetrics(input: {
  requested: number; quoted: number; awaitingPayment: number; inProgress: number;
  expiredRequests: number; expiredQuotes: number; expiredPayments: number;
  oldestExpiryLagSeconds: number; overdue: number;
  retentionUnacceptedClosed: number; retentionAccepted: number;
}): void {
  assertSafeStructuredData(input, "metric");
  const counts = [input.requested, input.quoted, input.awaitingPayment, input.inProgress, input.expiredRequests, input.expiredQuotes, input.expiredPayments, input.overdue, input.retentionUnacceptedClosed, input.retentionAccepted];
  if (!counts.every((n) => Number.isSafeInteger(n) && n >= 0) || !Number.isFinite(input.oldestExpiryLagSeconds) || input.oldestExpiryLagSeconds < 0 ||
    input.expiredRequests > input.requested || input.expiredQuotes > input.quoted || input.expiredPayments > input.awaitingPayment || input.overdue > input.inProgress) rejectUnsafeMetric();
  commissionOrdersCurrent.set({ state: "requested" }, input.requested);
  commissionOrdersCurrent.set({ state: "quoted" }, input.quoted);
  commissionOrdersCurrent.set({ state: "awaiting_payment" }, input.awaitingPayment);
  commissionOrdersCurrent.set({ state: "in_progress" }, input.inProgress);
  commissionExpiryBacklog.set({ state: "requested" }, input.expiredRequests);
  commissionExpiryBacklog.set({ state: "quoted" }, input.expiredQuotes);
  commissionExpiryBacklog.set({ state: "awaiting_payment" }, input.expiredPayments);
  commissionExpiryLag.set(input.oldestExpiryLagSeconds);
  commissionOverdue.set(input.overdue);
  commissionRetentionInventory.set({ dataset: "unaccepted_closed_90d" }, input.retentionUnacceptedClosed);
  commissionRetentionInventory.set({ dataset: "accepted" }, input.retentionAccepted);
}
export function recordCommissionOperation(input: { operation: string; outcome: string; count?: number }): void {
  assertSafeStructuredData(input, "metric"); const count = input.count ?? 1;
  if (!Object.hasOwn(commissionOutcomes, input.operation) || !commissionOutcomes[input.operation]?.includes(input.outcome) || !Number.isSafeInteger(count) || count < 0 || count > 500) rejectUnsafeMetric();
  commissionOperationsTotal.inc({ operation: input.operation, outcome: input.outcome }, count);
}

const commissionFileOutcomes: Readonly<Record<string, readonly string[]>> = Object.freeze({
  grant: ["accepted", "rejected", "disabled", "rate_limited", "failed"],
  complete: ["accepted", "rejected", "disabled", "rate_limited", "failed"],
  discard: ["accepted", "rejected", "disabled", "rate_limited", "failed"],
  download: ["accepted", "rejected", "disabled", "rate_limited", "failed"],
  scan: ["clean", "rejected", "retry", "scan_failed", "skipped", "failed"],
  maintenance: ["completed", "failed", "expired", "discarded", "scan_failed", "recovered", "purged", "purge_failed", "retention_deleted"],
});
const commissionFileOperationsTotal = new Counter({ name: "pawket_commission_file_operations_total", help: "Commission file operations by fixed operation and outcome; never file names, keys or URLs.", labelNames: ["operation", "outcome"], registers: [metricsRegistry] });
const commissionFileScannerUp = new Gauge({ name: "pawket_commission_file_scanner_up", help: "1 when clamd answered the last VERSION probe. Informational; not part of worker readiness.", registers: [metricsRegistry] });
const commissionFileSignatureAge = new Gauge({ name: "pawket_commission_file_signature_age_seconds", help: "Age of the clamd signature database at the last successful probe; -1 when unknown.", registers: [metricsRegistry] });
const commissionFilesScanning = new Gauge({ name: "pawket_commission_files_scanning", help: "Commission files uploaded and waiting for or inside a malware scan.", registers: [metricsRegistry] });
const commissionFilesOldestScanning = new Gauge({ name: "pawket_commission_files_oldest_scanning_seconds", help: "Seconds since the oldest scanning file finished uploading; 0 when none.", registers: [metricsRegistry] });
const commissionFilesRetentionDue = new Gauge({ name: "pawket_commission_files_retention_due", help: "Attached files past retention in the last sweep batch. Report only unless enforcement is approved.", registers: [metricsRegistry] });
const safeCount = (value: unknown, maximum: number) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
export function recordCommissionFileOperation(input: { operation: string; outcome: string; count?: number }): void {
  assertSafeStructuredData(input, "metric"); const count = input.count ?? 1;
  if (!Object.hasOwn(commissionFileOutcomes, input.operation) || !commissionFileOutcomes[input.operation]?.includes(input.outcome) || !safeCount(count, 500)) rejectUnsafeMetric();
  commissionFileOperationsTotal.inc({ operation: input.operation, outcome: input.outcome }, count);
}
export function setCommissionFileScannerMetric(input: { up: boolean; signatureAgeSeconds: number | null }): void {
  assertSafeStructuredData(input, "metric");
  if (typeof input.up !== "boolean" || (input.signatureAgeSeconds !== null && !safeCount(input.signatureAgeSeconds, 10 * 365 * 86_400))) rejectUnsafeMetric();
  commissionFileScannerUp.set(input.up ? 1 : 0); commissionFileSignatureAge.set(input.signatureAgeSeconds ?? -1);
}
export function setCommissionFileBacklogMetrics(input: { scanning: number; oldestScanningSeconds: number | null; retentionDue: number }): void {
  assertSafeStructuredData(input, "metric");
  if (!safeCount(input.scanning, 1_000_000) || !safeCount(input.retentionDue, 500) || (input.oldestScanningSeconds !== null && !safeCount(input.oldestScanningSeconds, 10 * 365 * 86_400))) rejectUnsafeMetric();
  commissionFilesScanning.set(input.scanning); commissionFilesOldestScanning.set(input.oldestScanningSeconds ?? 0); commissionFilesRetentionDue.set(input.retentionDue);
}

const tipOperationsTotal = new Counter({ name: "pawket_tip_operations_total", help: "Tip operation attempts by fixed operation and outcome; not proof of bank settlement.", labelNames: ["operation", "outcome"], registers: [metricsRegistry] });
const tipPaymentsEnabled = new Gauge({ name: "pawket_tip_payments_enabled", help: "Whether tip payment operations are enabled in this process.", registers: [metricsRegistry] });
const tipOutcomes: Readonly<Record<string, readonly string[]>> = {
  create: ["accepted", "replayed", "rejected", "rate_limited", "disabled", "failed"],
  qr: ["produced", "failed"], claim: ["recorded", "replayed", "rejected", "rate_limited", "disabled", "failed"],
  confirm: ["accepted", "replayed", "evidence_mismatch", "bank_transaction_conflict", "intent_not_pending", "idempotency_conflict", "recent_auth_required", "totp_required", "rejected", "rate_limited", "disabled", "failed"],
  expiry: ["completed", "expired", "failed"], notification: ["created", "already_materialized", "attention_required", "failed"],
};
export function recordTipOperation(input: { operation: string; outcome: string; count?: number }): void {
  assertSafeStructuredData(input, "metric"); const count = input.count ?? 1;
  if (!Object.hasOwn(tipOutcomes, input.operation) || !tipOutcomes[input.operation]?.includes(input.outcome) || !Number.isSafeInteger(count) || count < 0 || count > 500) rejectUnsafeMetric();
  tipOperationsTotal.inc({ operation: input.operation, outcome: input.outcome }, count);
}
export function setTipPaymentsEnabledMetric(enabled: boolean): void {
  if (typeof enabled !== "boolean") rejectUnsafeMetric();
  tipPaymentsEnabled.set(enabled ? 1 : 0);
}

const sepayOperationsTotal = new Counter({ name: "pawket_sepay_operations_total", help: "SePay operations by fixed operation and outcome, without payment identifiers.", labelNames: ["operation", "outcome"], registers: [metricsRegistry] });
const sepayLookupDurationSeconds = new Histogram({ name: "pawket_sepay_lookup_duration_seconds", help: "Scoped provider readback latency in seconds.", registers: [metricsRegistry] });
const sepayBacklog = new Gauge({ name: "pawket_sepay_inbox_total", help: "Current SePay inbox backlog by fixed state.", labelNames: ["state"], registers: [metricsRegistry] });
const sepayInboxOldestAgeSeconds = new Gauge({ name: "pawket_sepay_inbox_oldest_age_seconds", help: "Age of the oldest pending SePay receipt in seconds.", registers: [metricsRegistry] });
const sepayRecoveryEnabled = new Gauge({ name: "pawket_sepay_recovery_enabled", help: "Whether SePay reconciliation recovery is configured in this worker.", registers: [metricsRegistry] });
const sepayOutcomes: Readonly<Record<string, readonly string[]>> = {
  ingress: ["accepted", "ignored", "duplicate", "conflict", "auth_failed", "rate_limited", "disabled", "failed"],
  lookup: ["complete", "inconclusive", "rate_limited", "failed"],
  reconcile: ["confirmed", "review_required", "deferred", "unchanged", "retry_exhausted", "failed"],
  recovery: ["completed", "failed"],
};
export function recordSePayOperation(input: { operation: string; outcome: string; durationSeconds?: number }): void {
  assertSafeStructuredData(input, "metric");
  if (!Object.hasOwn(sepayOutcomes, input.operation) || !sepayOutcomes[input.operation]?.includes(input.outcome) ||
    (input.durationSeconds !== undefined && (input.operation !== "lookup" || !Number.isFinite(input.durationSeconds) || input.durationSeconds < 0))) rejectUnsafeMetric();
  sepayOperationsTotal.inc({ operation: input.operation, outcome: input.outcome });
  if (input.durationSeconds !== undefined) sepayLookupDurationSeconds.observe(input.durationSeconds);
}
export function setSePayBacklogMetrics(input: { pending: number; reviewRequired: number; oldestAgeSeconds: number }): void {
  assertSafeStructuredData(input, "metric");
  if (![input.pending, input.reviewRequired].every((value) => Number.isSafeInteger(value) && value >= 0) || !Number.isFinite(input.oldestAgeSeconds) || input.oldestAgeSeconds < 0) rejectUnsafeMetric();
  sepayBacklog.set({ state: "pending" }, input.pending);
  sepayBacklog.set({ state: "review_required" }, input.reviewRequired);
  sepayInboxOldestAgeSeconds.set(input.oldestAgeSeconds);
}
export function setSePayRecoveryEnabledMetric(enabled: boolean): void {
  if (typeof enabled !== "boolean") rejectUnsafeMetric();
  sepayRecoveryEnabled.set(enabled ? 1 : 0);
}

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

const catalogOperationsTotal = new Counter({
  name: "pawket_catalog_operations_total",
  help: "Creator catalog page operations by closed operation and outcome.",
  labelNames: ["operation", "outcome"],
  registers: [metricsRegistry],
});

const publicMediaOperationsTotal = new Counter({
  name: "pawket_public_media_operations_total",
  help: "Bounded public media operations by closed operation, outcome, purpose, and variant.",
  labelNames: ["operation", "outcome", "purpose", "variant"],
  registers: [metricsRegistry],
});

const creatorDirectoryResolutionsTotal = new Counter({
  name: "pawket_creator_directory_resolutions_total",
  help: "Creator handle directory resolutions by closed source and outcome.",
  labelNames: ["source", "outcome"],
  registers: [metricsRegistry],
});

const publicContentReportOperationsTotal = new Counter({
  name: "pawket_public_content_report_operations_total",
  help: "Public content report operations by closed operation, outcome, and reason.",
  labelNames: ["operation", "outcome", "reason"],
  registers: [metricsRegistry],
});

const publicMediaOldestPendingSeconds = new Gauge({
  name: "pawket_public_media_oldest_pending_seconds",
  help: "Age of the oldest pending public media processing job in seconds.",
  registers: [metricsRegistry],
});

const publicContentReportOldestOpenSeconds = new Gauge({
  name: "pawket_public_content_report_oldest_open_seconds",
  help: "Age of the oldest open public content report in seconds.",
  registers: [metricsRegistry],
});

const publicMediaStorageAvailable = new Gauge({
  name: "pawket_public_media_storage_available",
  help: "Whether a public media storage area is currently reachable.",
  labelNames: ["area"],
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
  "/api/v1/admin/content-reports",
  "/api/v1/admin/content-reports/[reportId]",
  "/api/v1/auth",
  "/api/v1/content-reports",
  "/api/v1/content-reports/challenge",
  "/api/v1/creator",
  "/api/v1/creator-page",
  "/api/v1/creator-page/handle",
  "/api/v1/creator-page/media/uploads",
  "/api/v1/creator-page/media/uploads/[intentId]/complete",
  "/api/v1/creator-page/publish",
  "/api/v1/creator-page/showcases",
  "/api/v1/creator-page/unpublish",
  "/api/v1/me",
  "/api/v1/tips/guest-context",
  "/api/v1/creator/tips",
  "/api/v1/commissions", "/api/v1/creator/commissions", "/api/v1/creator/commissions/packages", "/api/v1/creator/commissions/packages/change", "/api/v1/creator/commissions/settings",
  "/api/v1/public/creators/[handle]/commissions",
  ...["/api/v1/commissions/[orderId]", "/api/v1/creator/commissions/[orderId]"].flatMap((path) => [path, ...["accept", "quote", "close", "claim", "confirm", "quotes", "timeline"].map((action) => `${path}/${action}`)]),
  "/api/v1/creator/tips/sepay",
  "/api/v1/creator/tips/sepay/start",
  "/api/v1/creator/tips/sepay/callback",
  "/api/v1/creator/tips/sepay/reviews",
  "/api/v1/creator/tips/sepay/[connectionId]/accounts",
  "/api/v1/creator/tips/sepay/[connectionId]/bind",
  "/api/v1/creator/tips/sepay/[connectionId]/change",
  "/api/v1/creator/tips/sepay/reviews/[inboxId]/confirm",
  "/api/v1/creator/tips/sepay/reviews/[inboxId]/decide",
  "/api/v1/admin/sepay",
  "/api/v1/webhooks/sepay/[connectionId]",
  "/api/v1/creator/tip-settings",
  "/api/v1/creator/tips/[id]/confirm",
  "/api/v1/tips/[reference]",
  "/api/v1/tips/[reference]/transfer-claims",
  "/api/v1/public/creators/[handle]/tips",
  "/media/[assetId]/[variant]",
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
  "tip_status",
]);
const allowedEmailOutcomes = new Set([
  "attention_required",
  "queued",
  "retryable_failure",
  "sent",
]);
const allowedWorkerScans = new Set(["outbox", "public_media_cleanup", "refund", "retention", "tip_expiry", "sepay_recovery", "commission_cleanup", "oidc_cleanup", "commission_files"]);
const allowedRetentionDatasets = new Set([
  "tip_guest_capabilities", "tip_guest_content", "tip_instructions", "tip_claims", "tip_confirmations",
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
const allowedAuthAbuseControls = new Set(["password_sign_in", "oidc_start", "oidc_callback", "oidc_logout"]);
const allowedServices = new Set(["web", "worker"]);
const allowedCatalogOperations = new Set([
  "draft",
  "publish",
  "unpublish",
  "handle_claim",
  "handle_rename",
]);
const allowedPublicMediaOperations = new Set(["upload", "process", "delivery"]);
const allowedPublicMediaPurposes = new Set(["avatar", "cover", "showcase"]);
const allowedPublicMediaVariants = new Set(["master", "thumb", "display", "large", "none"]);
const allowedPublicMediaOutcomesByOperation = new Map<string, ReadonlySet<string>>([
  ["upload", allowedStandardOperationOutcomes],
  ["process", allowedSharedOutcomes],
  ["delivery", allowedStandardOperationOutcomes],
]);
const allowedCreatorDirectorySources = new Set(["canonical", "alias", "unknown"]);
const allowedPublicContentReportOperations = new Set([
  "submit",
  "challenge",
  "dismiss",
  "hide",
  "restore",
]);
const allowedPublicReportReasons = new Set([
  "impersonation",
  "prohibited_or_age_restricted_content",
  "harassment_or_hate",
  "violence_or_self_harm",
  "privacy",
  "intellectual_property",
  "spam_or_scam",
  "other",
  "none",
]);
const allowedPublicMediaStorageAreas = new Set(["quarantine", "derivative"]);

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

export function recordCatalogOperation(input: {
  operation: string;
  outcome: string;
}): void {
  recordClosedOperation(
    catalogOperationsTotal,
    input,
    allowedCatalogOperations,
    allowedStandardOperationOutcomes,
  );
}

export function recordPublicMediaOperation(input: {
  operation: string;
  outcome: string;
  purpose?: string;
  variant?: string;
}): void {
  assertSafeStructuredData(input, "metric");
  const purpose = input.purpose ?? "none";
  const variant = input.variant ?? "none";
  const allowedOutcomes =
    allowedPublicMediaOutcomesByOperation.get(input.operation) ?? new Set<string>();
  if (
    !allowedPublicMediaOperations.has(input.operation) ||
    !allowedSharedOutcomes.has(input.outcome) ||
    !allowedOutcomes.has(input.outcome) ||
    (input.purpose !== undefined && !allowedPublicMediaPurposes.has(input.purpose)) ||
    (input.variant !== undefined && !allowedPublicMediaVariants.has(input.variant))
  ) {
    rejectUnsafeMetric();
  }
  publicMediaOperationsTotal.inc({
    operation: input.operation,
    outcome: input.outcome,
    purpose,
    variant,
  });
}

export function recordCreatorDirectoryResolution(input: {
  source: string;
  outcome: string;
}): void {
  assertSafeStructuredData(input, "metric");
  if (
    !allowedCreatorDirectorySources.has(input.source) ||
    !allowedSharedOutcomes.has(input.outcome) ||
    !allowedStandardOperationOutcomes.has(input.outcome)
  ) {
    rejectUnsafeMetric();
  }
  creatorDirectoryResolutionsTotal.inc({ source: input.source, outcome: input.outcome });
}

export function recordContentReportOperation(input: {
  operation: string;
  outcome: string;
  reason?: string;
}): void {
  assertSafeStructuredData(input, "metric");
  const reason = input.reason ?? "none";
  if (
    !allowedPublicContentReportOperations.has(input.operation) ||
    !allowedSharedOutcomes.has(input.outcome) ||
    !allowedStandardOperationOutcomes.has(input.outcome) ||
    !allowedPublicReportReasons.has(reason)
  ) {
    rejectUnsafeMetric();
  }
  publicContentReportOperationsTotal.inc({
    operation: input.operation,
    outcome: input.outcome,
    reason,
  });
}

export function setPublicMediaProcessingBacklogMetric(input: {
  oldestPendingSeconds: number;
}): void {
  assertSafeStructuredData(input, "metric");
  if (
    !Number.isFinite(input.oldestPendingSeconds) ||
    input.oldestPendingSeconds < 0
  ) {
    rejectUnsafeMetric();
  }
  publicMediaOldestPendingSeconds.set(input.oldestPendingSeconds);
}

export function setPublicContentReportBacklogMetric(input: {
  oldestOpenSeconds: number;
}): void {
  assertSafeStructuredData(input, "metric");
  if (
    !Number.isFinite(input.oldestOpenSeconds) ||
    input.oldestOpenSeconds < 0
  ) {
    rejectUnsafeMetric();
  }
  publicContentReportOldestOpenSeconds.set(input.oldestOpenSeconds);
}

export function setPublicMediaStorageAvailabilityMetric(input: {
  area: string;
  available: boolean;
}): void {
  assertSafeStructuredData(input, "metric");
  if (!allowedPublicMediaStorageAreas.has(input.area) || typeof input.available !== "boolean") {
    rejectUnsafeMetric();
  }
  publicMediaStorageAvailable.set({ area: input.area }, input.available ? 1 : 0);
}
