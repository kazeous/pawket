export type TrustEnforcementMode = "disabled" | "enabled";

export const TRUST_ENFORCEMENT_POLICY = Object.freeze({
  appealWindowMs: 1_209_600_000, helpLinkAppealMs: 1_209_600_000, helpReadOnlyMs: 7_776_000_000,
  helpSessionMs: 1_800_000, resumeGraceMs: 172_800_000, messageContext: 20, reportDetailMax: 1_000,
  explanationMax: 2_000, internalNoteMax: 2_000, actionReasonMax: 2_000, appealStatementMax: 4_000,
  decisionReasoningMax: 4_000, policyDocumentMax: 16_000, actorReportLimit: 10, guestReportLimit: 5,
  reportWindowMs: 900_000, linkRequestsPerAddress: 3, linkAddressWindowMs: 86_400_000,
  linkRequestsPerNetwork: 10, linkNetworkWindowMs: 3_600_000,
});
export const TRUST_RESTRICTIONS = ["commission_intake", "commission_buying", "dispute_opening", "reporting"] as const;
export const TRUST_PENALTY_KINDS = ["warning", "restriction", "suspension", "removal"] as const;
export const TRUST_PENALTY_TARGETS = ["creator_capability", "account"] as const;
export const TRUST_PENALTY_REASONS = ["spam_or_scam", "harassment_or_hate", "prohibited_or_age_restricted_content",
  "intellectual_property", "privacy", "impersonation", "refund_non_compliance", "dispute_or_report_abuse", "other"] as const;
export const TRUST_POLICY_KINDS = ["community_rules", "enforcement_appeals"] as const;
export type TrustRestriction = typeof TRUST_RESTRICTIONS[number];
export type TrustPenaltyKind = typeof TRUST_PENALTY_KINDS[number];
export type TrustPenaltyTarget = typeof TRUST_PENALTY_TARGETS[number];
export type TrustPenaltyReason = typeof TRUST_PENALTY_REASONS[number];
export type TrustPolicyKind = typeof TRUST_POLICY_KINDS[number];
export type TrustEnforcementErrorCode = "not_available" | "invalid_request" | "enforcement_disabled" | "not_authorized"
  | "owner_step_up_required" | "version_conflict" | "idempotency_conflict" | "restricted" | "duplicate" | "rate_limited"
  | "window_closed" | "invalid_transition" | "resolution_disabled" | "use_penalty" | "dependency_unavailable";
export class TrustEnforcementError extends Error {
  constructor(readonly code: TrustEnforcementErrorCode) { super(code); this.name = "TrustEnforcementError"; }
}
export function trustFail(code: TrustEnforcementErrorCode): never { throw new TrustEnforcementError(code); }

export function normalizeTrustText(value: unknown, min: number, max: number, options?: { multiline?: boolean }): string {
  if (typeof value !== "string" || !Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 0 || max < min) trustFail("invalid_request");
  const text = value.normalize("NFC"); const checked = options?.multiline ? text.replaceAll("\n", "") : text;
  // Lone surrogates cannot be represented faithfully by the database's UTF-8 text.
  if (/[\p{Cc}\p{Cs}]/u.test(checked)) trustFail("invalid_request");
  const length = [...text].length;
  if (length < min || length > max) trustFail("invalid_request");
  return text;
}
