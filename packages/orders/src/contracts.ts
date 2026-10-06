export const COMMISSION_ROUTES = ["fixed_immediate", "fixed_approval", "custom_quote"] as const;
export type CommissionRoute = typeof COMMISSION_ROUTES[number];
export const COMMISSION_STATES = ["requested", "quoted", "awaiting_payment", "in_progress", "delivered", "completed", "closed"] as const;
export type CommissionState = typeof COMMISSION_STATES[number];
export const COMMISSION_COMPLETION_KINDS = ["buyer_accepted", "review_window_elapsed"] as const;
export type CommissionCompletionKind = typeof COMMISSION_COMPLETION_KINDS[number];
export const COMMISSION_CLOSE_REASONS = [
  "buyer_withdrawn", "creator_declined", "quote_withdrawn", "quote_declined",
  "request_expired", "quote_expired", "buyer_cancelled", "creator_cancelled",
  "payment_expired", "security_invalidated", "eligibility_invalidated",
] as const;
export type CommissionCloseReason = typeof COMMISSION_CLOSE_REASONS[number];
export const COMMISSION_ERRORS = [
  "not_authorized", "not_available", "intake_disabled", "payments_disabled", "invalid_request",
  "invalid_terms", "invalid_brief", "version_conflict", "policy_changed", "capacity_full",
  "request_limit", "expired", "invalid_transition", "idempotency_conflict", "evidence_mismatch",
  "recent_auth_required", "totp_required", "rate_limited", "dependency_unavailable",
  "files_disabled", "invalid_reference_files",
  "fulfillment_disabled", "revisions_exhausted", "completion_held", "invalid_attachment_files",
] as const;
export type CommissionErrorCode = typeof COMMISSION_ERRORS[number];
export class CommissionError extends Error {
  constructor(readonly code: CommissionErrorCode) { super(code); this.name = "CommissionError"; }
}
export function commissionFail(code: CommissionErrorCode): never { throw new CommissionError(code); }

export type CommissionActor = Readonly<{ userId: string; sessionId: string }>;
export type CommissionBrief = Readonly<{ text: string; referenceLinks: readonly string[] }>;
/** Each text field is independently bounded/encrypted when used in a private quote. */
export type CommissionTerms = Readonly<{
  amountVnd: number;
  turnaroundDays: number;
  revisionAllowance: number;
  reviewWindowDays: number;
  scope: string;
  deliverables: string;
  usageRights: string;
  artistTerms: string;
  policyRevisionId: string;
}>;
export type CommissionPackageDraft = Readonly<{
  title: string;
  description: string;
  discipline: string;
  route: CommissionRoute;
  briefInstructions: string;
  terms: CommissionTerms | null;
  showcaseId: string | null;
}>;
