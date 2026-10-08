export const DISPUTE_REASONS = ["not_delivered", "not_as_agreed", "incomplete_delivery", "creator_cannot_complete", "communication_breakdown", "other"] as const;
export const PROPOSAL_KINDS = ["cancel_with_refund", "complete_with_refund"] as const;
export const RULING_OUTCOMES = ["complete", "close"] as const;
export type DisputeReason = typeof DISPUTE_REASONS[number];
export type ProposalKind = typeof PROPOSAL_KINDS[number];
export type RulingOutcome = typeof RULING_OUTCOMES[number];
export const RESOLUTION_ERRORS = ["not_authorized", "not_available", "resolution_disabled", "invalid_request", "version_conflict", "invalid_transition",
  "idempotency_conflict", "proposal_limit", "proposal_pending", "proposal_stale", "dispute_open", "dispute_not_allowed", "statement_limit",
  "deadline_passed", "owner_step_up_required", "dependency_unavailable"] as const;
export type ResolutionErrorCode = typeof RESOLUTION_ERRORS[number];
export class ResolutionError extends Error {
  constructor(readonly code: ResolutionErrorCode) { super(code); this.name = "ResolutionError"; }
}
export function resolutionFail(code: ResolutionErrorCode): never { throw new ResolutionError(code); }
export type ResolutionActor = Readonly<{ userId: string; sessionId: string }>;
export type ResolutionCommand = Readonly<{ actor: ResolutionActor; idempotencyKey: string; requestId: string }>;
export type ResolutionOwnerCommand = Readonly<{ owner: ResolutionActor; stepUpProofId: string; idempotencyKey: string; requestId: string }>;
