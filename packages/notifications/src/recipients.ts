import { and, eq, isNotNull } from "drizzle-orm";
import {
  commissionDisputes, commissionDisputeStatements, commissionLatePaymentClaims, commissionOrders, commissionProposals, commissionRulingCorrections,
  commissionRulings, creatorApplications, findRefundEmailContext, identityCreatorCapabilities, identityRoleGrants, paymentIntents, trustAppeals,
  trustCases, trustContentHides, trustPenalties, trustReports, type PawketTransaction, type systemOutbox,
} from "@pawket/database";
import {
  NOTIFICATION_VARIANT_PATTERN, caseLink, orderLink, type NoticeDraft, type NotificationCategory, type NotificationKind, type NotificationSubjectType,
} from "./catalog.js";
import { NotificationError } from "./policy.js";

/** The committed `system_outbox` row, read by id. Recipients come from it and from the rows it names, never from a job payload. */
export type CommittedOutboxRow = typeof systemOutbox.$inferSelect;

type Role = "buyer" | "creator";
type Order = Readonly<{ id: string; buyerUserId: string; creatorUserId: string }>;
type Notice = Readonly<{ kind: NotificationKind; category: NotificationCategory; action: boolean; subjectType: NotificationSubjectType; subjectId: string;
  variant?: string | null; email?: NoticeDraft["email"] }>;

const HELP_CASES = "/help/cases";
const TIPS = "/creator/tips";
const DEPOSIT_REFUND_STATES: Readonly<Record<string, string>> = {
  "payments.receiving_account_control_verified.v1": "pending_window",
  "payments.verification_deposit_refund_due_soon.v1": "ready",
  "payments.verification_deposit_refund_due_today.v1": "due_today",
  "payments.verification_deposit_refund_overdue.v1": "overdue",
  "payments.verification_deposit_refund_sent.v1": "sent",
  "payments.verification_deposit_refund_attention_required.v1": "attention_required",
};
const PENALTY_KINDS = new Set(["warning", "restriction", "suspension", "removal"]);

/** A missing or inconsistent source row stops the event; the outbox retries instead of guessing a recipient. */
function unavailable(): never { throw new NotificationError("dependency_unavailable"); }
function text(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]; return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : unavailable();
}
function variantOf(value: unknown): string | null {
  return typeof value === "string" && NOTIFICATION_VARIANT_PATTERN.test(value) ? value : null;
}
function aggregate(source: CommittedOutboxRow, type: string, idKey?: string): string {
  if (source.aggregateType !== type || (idKey !== undefined && source.payload[idKey] !== source.aggregateId)) unavailable();
  return source.aggregateId;
}
function opposite(role: string): Role {
  return role === "buyer" ? "creator" : role === "creator" ? "buyer" : unavailable();
}

function draft(recipientUserId: string, linkPath: string, notice: Notice): NoticeDraft {
  return { recipientUserId, kind: notice.kind, variant: notice.variant ?? null, category: notice.category, actionRequired: notice.action,
    subjectType: notice.subjectType, subjectId: notice.subjectId, linkPath, email: notice.email ?? "now" };
}
function toRoles(order: Order, roles: readonly Role[], notice: Notice): NoticeDraft[] {
  return roles.map((role) => draft(role === "buyer" ? order.buyerUserId : order.creatorUserId, orderLink(role, order.id), notice));
}
const BOTH: readonly Role[] = ["buyer", "creator"];

async function readOrder(tx: PawketTransaction, orderId: unknown): Promise<Order> {
  if (typeof orderId !== "string") unavailable();
  const [order] = await tx.select({ id: commissionOrders.id, buyerUserId: commissionOrders.buyerUserId, creatorUserId: commissionOrders.creatorUserId })
    .from(commissionOrders).where(eq(commissionOrders.id, orderId)).limit(1);
  return order ?? unavailable();
}
async function readDispute(tx: PawketTransaction, disputeId: string) {
  const [dispute] = await tx.select({ id: commissionDisputes.id, orderId: commissionDisputes.orderId, openerRole: commissionDisputes.openerRole, state: commissionDisputes.state })
    .from(commissionDisputes).where(eq(commissionDisputes.id, disputeId)).limit(1);
  return dispute ?? unavailable();
}

const ORDER_NOTICES: Readonly<Record<string, Readonly<{ kind: NotificationKind; roles: readonly Role[]; action: boolean }>>> = {
  "commission.requested.v1": { kind: "order_requested", roles: ["creator"], action: true },
  "commission.quoted.v1": { kind: "order_quoted", roles: ["buyer"], action: true },
  "commission.awaiting_payment.v1": { kind: "order_payment_due", roles: ["buyer"], action: true },
  "commission.transfer_claimed.v1": { kind: "order_transfer_claimed", roles: ["creator"], action: true },
  "commission.delivered.v1": { kind: "order_delivered", roles: ["buyer"], action: true },
  "commission.completed.v1": { kind: "order_completed", roles: BOTH, action: false },
  "commission.closed.v1": { kind: "order_closed", roles: BOTH, action: false },
};

async function commissionNotices(tx: PawketTransaction, source: CommittedOutboxRow): Promise<readonly NoticeDraft[]> {
  const type = source.eventType; const payload = source.payload;
  // Ruling R7: payment confirmation commits only commission.confirmed.v1 (payment_intent aggregate); it is the
  // "payment confirmed, work started" notice. commission.in_progress.v1 is a reopen after a buyer's change request,
  // already announced to the creator by commission.submission_responded.v1, so it produces nothing.
  if (type === "commission.confirmed.v1") {
    const intentId = aggregate(source, "payment_intent", "paymentIntentId");
    const [intent] = await tx.select({ purpose: paymentIntents.purpose, orderId: paymentIntents.commissionOrderId }).from(paymentIntents).where(eq(paymentIntents.id, intentId)).limit(1);
    if (!intent || intent.purpose !== "commission" || intent.orderId === null || intent.orderId !== payload.orderId) unavailable();
    const order = await readOrder(tx, intent.orderId);
    return toRoles(order, BOTH, { subjectType: "commission_order", subjectId: order.id, kind: "order_in_progress", category: "orders", action: false });
  }
  if (type === "commission.in_progress.v1") { aggregate(source, "commission_order", "orderId"); return []; }
  const order = await readOrder(tx, aggregate(source, "commission_order", "orderId"));
  const subject = { subjectType: "commission_order", subjectId: order.id } as const;
  const known = ORDER_NOTICES[type];
  if (known) {
    const variant = type === "commission.closed.v1" ? variantOf(payload.reason) : null;
    return toRoles(order, known.roles, { ...subject, kind: known.kind, category: "orders", action: known.action, variant });
  }
  if (type === "commission.submission_sent.v1") {
    const kind = text(payload, "kind"); if (kind !== "draft" && kind !== "final") unavailable();
    // A final submission is announced by commission.delivered.v1.
    return kind === "draft" ? toRoles(order, ["buyer"], { ...subject, kind: "draft_sent", category: "deliveries", action: false }) : [];
  }
  if (type === "commission.submission_responded.v1") {
    return toRoles(order, ["creator"], { ...subject, kind: "draft_responded", category: "deliveries", action: false, variant: variantOf(text(payload, "response")) });
  }
  return unavailable();
}

async function resolutionNotices(tx: PawketTransaction, source: CommittedOutboxRow): Promise<readonly NoticeDraft[]> {
  const type = source.eventType; const payload = source.payload;
  const disputes = { category: "disputes_refunds" } as const;
  if (type === "resolution.proposal_made.v1" || type === "resolution.proposal_ended.v1") {
    const proposalId = aggregate(source, "commission_proposal", "proposalId");
    const [proposal] = await tx.select({ orderId: commissionProposals.orderId, proposerRole: commissionProposals.proposerRole, state: commissionProposals.state })
      .from(commissionProposals).where(eq(commissionProposals.id, proposalId)).limit(1);
    if (!proposal || proposal.orderId !== payload.orderId) unavailable();
    const order = await readOrder(tx, proposal.orderId); const subject = { subjectType: "commission_proposal", subjectId: proposalId } as const;
    if (type === "resolution.proposal_made.v1") return toRoles(order, [opposite(proposal.proposerRole)], { ...disputes, ...subject, kind: "proposal_received", action: true });
    return toRoles(order, BOTH, { ...disputes, ...subject, kind: "proposal_ended", action: false, variant: variantOf(text(payload, "state")) });
  }
  if (type === "resolution.dispute_opened.v1" || type === "resolution.dispute_closed.v1" || type === "resolution.dispute_statement_added.v1") {
    const dispute = await readDispute(tx, aggregate(source, "commission_dispute", "disputeId"));
    if (type !== "resolution.dispute_statement_added.v1" && dispute.orderId !== payload.orderId) unavailable();
    const order = await readOrder(tx, dispute.orderId); const subject = { subjectType: "commission_dispute", subjectId: dispute.id } as const;
    if (type === "resolution.dispute_opened.v1") return toRoles(order, [opposite(dispute.openerRole)], { ...disputes, ...subject, kind: "dispute_opened", action: true });
    if (type === "resolution.dispute_closed.v1") return toRoles(order, BOTH, { ...disputes, ...subject, kind: "dispute_closed", action: false, variant: variantOf(text(payload, "state")) });
    const [statement] = await tx.select({ authorRole: commissionDisputeStatements.authorRole }).from(commissionDisputeStatements)
      .where(and(eq(commissionDisputeStatements.id, text(payload, "statementId")), eq(commissionDisputeStatements.disputeId, dispute.id))).limit(1);
    if (!statement || statement.authorRole !== payload.authorRole) unavailable();
    // An owner question reaches both parties; a party's statement reaches the other party. The owner never gets one.
    const roles = statement.authorRole === "owner" ? BOTH : [opposite(statement.authorRole)];
    return toRoles(order, roles, { ...disputes, ...subject, kind: "dispute_statement", action: false });
  }
  if (type === "resolution.ruling_recorded.v1" || type === "resolution.ruling_corrected.v1") {
    const recorded = type === "resolution.ruling_recorded.v1";
    let rulingId = recorded ? aggregate(source, "commission_ruling", "rulingId") : "";
    if (!recorded) {
      const correctionId = aggregate(source, "commission_ruling_correction", "correctionId");
      const [correction] = await tx.select({ rulingId: commissionRulingCorrections.rulingId }).from(commissionRulingCorrections)
        .where(eq(commissionRulingCorrections.id, correctionId)).limit(1);
      if (!correction || correction.rulingId !== payload.rulingId) unavailable();
      rulingId = correction.rulingId;
    }
    const [ruling] = await tx.select({ disputeId: commissionRulings.disputeId }).from(commissionRulings).where(eq(commissionRulings.id, rulingId)).limit(1);
    if (!ruling || (recorded && ruling.disputeId !== payload.disputeId)) unavailable();
    const dispute = await readDispute(tx, ruling.disputeId);
    if (recorded && dispute.orderId !== payload.orderId) unavailable();
    return toRoles(await readOrder(tx, dispute.orderId), BOTH, { ...disputes, subjectType: "commission_dispute", subjectId: dispute.id,
      kind: recorded ? "ruling_recorded" : "ruling_corrected", action: true });
  }
  if (type === "resolution.late_claim_filed.v1" || type === "resolution.late_claim_ended.v1") {
    const claimId = aggregate(source, "commission_late_payment_claim", "claimId");
    const [claim] = await tx.select({ orderId: commissionLatePaymentClaims.orderId }).from(commissionLatePaymentClaims).where(eq(commissionLatePaymentClaims.id, claimId)).limit(1);
    if (!claim || claim.orderId !== payload.orderId) unavailable();
    const order = await readOrder(tx, claim.orderId); const subject = { subjectType: "commission_late_payment_claim", subjectId: claimId } as const;
    if (type === "resolution.late_claim_filed.v1") return toRoles(order, ["creator"], { ...disputes, ...subject, kind: "late_claim_filed", action: true });
    return toRoles(order, BOTH, { ...disputes, ...subject, kind: "late_claim_ended", action: false, variant: variantOf(text(payload, "state")) });
  }
  // P3: the freeze closes each order (commission.closed.v1) and opens a refund obligation; no third notice.
  if (type === "resolution.fulfillment_frozen.v1") return [];
  return unavailable();
}

async function trustNotices(tx: PawketTransaction, source: CommittedOutboxRow): Promise<readonly NoticeDraft[]> {
  const type = source.eventType; const payload = source.payload;
  const moderation = { category: "moderation" } as const;
  if (type === "trust.case_opened.v1") {
    const caseId = aggregate(source, "trust_case", "caseId");
    const [row] = await tx.select({ kind: trustCases.kind }).from(trustCases).where(eq(trustCases.id, caseId)).limit(1);
    if (!row) unavailable();
    // P8: every active owner at materialization time. The item carries the case kind and the admin link only.
    const owners = await tx.select({ userId: identityRoleGrants.userId }).from(identityRoleGrants)
      .where(and(eq(identityRoleGrants.role, "owner"), eq(identityRoleGrants.state, "active")));
    return owners.map((owner) => draft(owner.userId, caseLink(caseId), { kind: "owner_case_opened", category: "owner_queue", action: false,
      subjectType: "trust_case", subjectId: caseId, variant: variantOf(row.kind) }));
  }
  if (type === "trust.report_received.v1") {
    const reportId = aggregate(source, "trust_report", "reportId");
    const [report] = await tx.select({ reporterUserId: trustReports.reporterUserId, caseId: trustReports.caseId }).from(trustReports).where(eq(trustReports.id, reportId)).limit(1);
    if (!report || report.caseId !== payload.caseId) unavailable();
    // A reporter learns only that the report arrived; a guest reporter has no account to notify.
    return report.reporterUserId === null ? [] : [draft(report.reporterUserId, HELP_CASES, { ...moderation, kind: "report_received", action: false, subjectType: "trust_report", subjectId: reportId })];
  }
  if (type === "trust.report_case_closed.v1") {
    const caseId = aggregate(source, "trust_case", "caseId");
    const reports = await tx.select({ reporterUserId: trustReports.reporterUserId }).from(trustReports)
      .where(and(eq(trustReports.caseId, caseId), isNotNull(trustReports.reporterUserId)));
    const reporters = [...new Set(reports.map((report) => report.reporterUserId!))];
    return reporters.map((reporter) => draft(reporter, HELP_CASES, { ...moderation, kind: "report_closed", action: false, subjectType: "trust_case", subjectId: caseId }));
  }
  if (type === "trust.content_hidden.v1" || type === "trust.content_restored.v1") {
    const hideId = aggregate(source, "trust_content_hide", "hideId");
    const [hide] = await tx.select({ ownerUserId: trustContentHides.contentOwnerUserId, caseId: trustContentHides.caseId }).from(trustContentHides)
      .where(eq(trustContentHides.id, hideId)).limit(1);
    if (!hide || hide.caseId !== payload.caseId) unavailable();
    const hidden = type === "trust.content_hidden.v1";
    return [draft(hide.ownerUserId, HELP_CASES, { ...moderation, kind: hidden ? "content_hidden" : "content_restored", action: hidden,
      subjectType: "trust_content_hide", subjectId: hideId })];
  }
  if (type === "trust.penalty_applied.v1" || type === "trust.penalty_ended.v1") {
    const penaltyId = aggregate(source, "trust_penalty", "penaltyId");
    const [penalty] = await tx.select({ subjectUserId: trustPenalties.subjectUserId, kind: trustPenalties.kind }).from(trustPenalties).where(eq(trustPenalties.id, penaltyId)).limit(1);
    if (!penalty || penalty.subjectUserId !== payload.subjectUserId) unavailable();
    const subject = { ...moderation, subjectType: "trust_penalty", subjectId: penaltyId } as const;
    if (type === "trust.penalty_ended.v1") return [draft(penalty.subjectUserId, HELP_CASES, { ...subject, kind: "penalty_ended", action: false })];
    if (!PENALTY_KINDS.has(penalty.kind) || penalty.kind !== payload.kind) unavailable();
    // The variant is always the penalty kind: the plain text mentions appeals, which a warning does not have.
    // Suspension and removal are in-app only; their enforcement_notice email already carries the appeal link.
    const emailed = penalty.kind === "warning" || penalty.kind === "restriction";
    return [draft(penalty.subjectUserId, HELP_CASES, { ...subject, kind: "penalty_applied", variant: penalty.kind, action: emailed, email: emailed ? "now" : "never" })];
  }
  if (type === "trust.appeal_submitted.v1" || type === "trust.appeal_decided.v1") {
    const appealId = aggregate(source, "trust_appeal", "appealId");
    const [appeal] = await tx.select({ appellantUserId: trustAppeals.appellantUserId, caseId: trustAppeals.caseId, state: trustAppeals.state }).from(trustAppeals)
      .where(eq(trustAppeals.id, appealId)).limit(1);
    if (!appeal || appeal.caseId !== payload.caseId) unavailable();
    const subject = { ...moderation, subjectType: "trust_appeal", subjectId: appealId } as const;
    if (type === "trust.appeal_submitted.v1") return [draft(appeal.appellantUserId, HELP_CASES, { ...subject, kind: "appeal_received", action: false })];
    const decision = text(payload, "decision"); if (decision !== appeal.state) unavailable();
    return [draft(appeal.appellantUserId, HELP_CASES, { ...subject, kind: "appeal_decided", action: true, variant: variantOf(decision) })];
  }
  return unavailable();
}

async function tipNotices(tx: PawketTransaction, source: CommittedOutboxRow): Promise<readonly NoticeDraft[]> {
  const payload = source.payload;
  if (source.eventType === "tip.notification_available.v1") {
    // Written by the worker after it validated the tip lifecycle event; the item stays in-app (tip_status email exists).
    if (source.aggregateType !== "tip_notification" || payload.sourceEventId !== source.aggregateId) unavailable();
    const state = text(payload, "state"); if (!["created", "confirmed", "expired"].includes(state)) unavailable();
    const intent = await readTipIntent(tx, text(payload, "paymentIntentId"));
    if (intent.creatorUserId !== payload.creatorUserId) unavailable();
    return [draft(intent.creatorUserId, TIPS, { kind: "tip_status", category: "tips", action: false, subjectType: "tip", subjectId: intent.tipId, variant: state, email: "never" })];
  }
  if (source.eventType === "tip.transfer_claimed.v1") {
    const intent = await readTipIntent(tx, aggregate(source, "payment_intent", "paymentIntentId"));
    if (intent.creatorUserId !== payload.creatorUserId || intent.tipId !== payload.tipId) unavailable();
    return [draft(intent.creatorUserId, TIPS, { kind: "tip_transfer_claimed", category: "tips", action: true, subjectType: "tip", subjectId: intent.tipId })];
  }
  return unavailable();
}
async function readTipIntent(tx: PawketTransaction, intentId: string) {
  const [intent] = await tx.select({ purpose: paymentIntents.purpose, tipId: paymentIntents.tipId, creatorUserId: paymentIntents.creatorUserId })
    .from(paymentIntents).where(eq(paymentIntents.id, intentId)).limit(1);
  if (!intent || intent.purpose !== "tip" || intent.tipId === null) unavailable();
  return { tipId: intent.tipId, creatorUserId: intent.creatorUserId };
}

async function accountNotices(tx: PawketTransaction, source: CommittedOutboxRow): Promise<readonly NoticeDraft[]> {
  const payload = source.payload; const account = { category: "account", action: false, email: "never" } as const;
  // Account items are in-app only: application_outcome, creator_status and refund_status emails already exist.
  if (source.eventType === "creator.application_outcome_email.v1") {
    const applicationId = aggregate(source, "creator_application", "applicationId");
    const [application] = await tx.select({ userId: creatorApplications.userId }).from(creatorApplications).where(eq(creatorApplications.id, applicationId)).limit(1);
    if (!application || application.userId !== payload.applicantUserId) unavailable();
    const variant = variantOf(payload.decisionAction ?? payload.state);
    return [draft(application.userId, "/creator/apply", { ...account, kind: "account_application", subjectType: "creator_application", subjectId: applicationId, variant })];
  }
  if (source.eventType === "creator.capability_outcome_email.v1") {
    const capabilityId = aggregate(source, "creator_capability", "capabilityId");
    const [capability] = await tx.select({ userId: identityCreatorCapabilities.userId }).from(identityCreatorCapabilities)
      .where(eq(identityCreatorCapabilities.id, capabilityId)).limit(1);
    if (!capability || capability.userId !== payload.userId) unavailable();
    return [draft(capability.userId, "/creator", { ...account, kind: "account_creator_status", subjectType: "creator_capability", subjectId: capabilityId, variant: variantOf(payload.state) })];
  }
  const state = DEPOSIT_REFUND_STATES[source.eventType];
  if (state) {
    const obligationId = aggregate(source, "verification_deposit_refund_obligation", "obligationId");
    const obligation = await findRefundEmailContext(tx, obligationId);
    if (!obligation) unavailable();
    return [draft(obligation.applicantUserId, "/creator/apply", { ...account, kind: "account_deposit_refund", subjectType: "verification_deposit", subjectId: obligationId, variant: state })];
  }
  return unavailable();
}

/** Resolves the notices one committed source event produces, per spec section 6 as amended by P1-P5. */
export async function resolveNotices(tx: PawketTransaction, source: CommittedOutboxRow): Promise<readonly NoticeDraft[]> {
  if (source.eventVersion !== 1 || !source.payload || typeof source.payload !== "object") unavailable();
  const type = source.eventType;
  if (type.startsWith("commission.")) return commissionNotices(tx, source);
  if (type.startsWith("resolution.")) return resolutionNotices(tx, source);
  if (type.startsWith("trust.")) return trustNotices(tx, source);
  if (type.startsWith("tip.")) return tipNotices(tx, source);
  if (type.startsWith("creator.") || type.startsWith("payments.")) return accountNotices(tx, source);
  return unavailable();
}
