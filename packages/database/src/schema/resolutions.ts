import { sql, type SQLWrapper } from "drizzle-orm";
import { bigint, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { EncryptionEnvelope } from "@pawket/security";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Drizzle Kit requires extensionless schema imports.
// @ts-ignore Drizzle Kit resolves this TypeScript schema without the emitted suffix.
import { commissionEnvelopeCheck, commissionOrders, commissionPolicyRevisions } from "./commissions";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Drizzle Kit requires extensionless schema imports.
// @ts-ignore Drizzle Kit resolves this TypeScript schema without the emitted suffix.
import { identityUsers } from "./identity-core";

const time = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const reference = { onDelete: "restrict", onUpdate: "restrict" } as const;
const identifier = (column: SQLWrapper) => sql`${column} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'`;

export const commissionProposals = pgTable("commission_proposals", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id").notNull().references(() => commissionOrders.id, reference),
  proposerUserId: text("proposer_user_id").notNull().references(() => identityUsers.id, reference),
  proposerRole: text("proposer_role").notNull(), kind: text("kind").notNull(),
  refundAmountVnd: bigint("refund_amount_vnd", { mode: "number" }).notNull(),
  noteEnvelope: jsonb("note_envelope").$type<EncryptionEnvelope<"commission_proposals", "note">>().notNull(),
  orderStateAtCreation: text("order_state_at_creation").notNull(), remainingReviewMs: bigint("remaining_review_ms", { mode: "number" }),
  state: text("state").notNull().default("pending"), respondBy: time("respond_by").notNull(), createdAt: time("created_at").notNull(),
  endedAt: time("ended_at"), endedByUserId: text("ended_by_user_id").references(() => identityUsers.id, reference),
  actorSessionId: text("actor_session_id").notNull(), requestId: text("request_id").notNull(), version: integer("version").notNull().default(1),
}, (t) => [
  uniqueIndex("commission_proposals_pending_uidx").on(t.orderId).where(sql`${t.state} = 'pending'`),
  index("commission_proposals_order_idx").on(t.orderId, t.createdAt), index("commission_proposals_deadline_idx").on(t.state, t.respondBy),
  check("commission_proposals_role_check", sql`${t.proposerRole} in ('buyer','creator')`),
  check("commission_proposals_kind_check", sql`${t.kind} in ('cancel_with_refund','complete_with_refund')
    and ${t.refundAmountVnd} between 0 and 50000000
    and (${t.kind} <> 'complete_with_refund' or (${t.orderStateAtCreation} = 'delivered' and ${t.refundAmountVnd} >= 1))`),
  check("commission_proposals_review_check", sql`(${t.orderStateAtCreation} = 'in_progress' and ${t.remainingReviewMs} is null)
    or (${t.orderStateAtCreation} = 'delivered' and ${t.remainingReviewMs} is not null and ${t.remainingReviewMs} >= 0)`),
  check("commission_proposals_state_check", sql`(${t.state} = 'pending' and ${t.endedAt} is null and ${t.endedByUserId} is null)
    or (${t.state} in ('accepted','declined','withdrawn','expired','lapsed','superseded') and ${t.endedAt} is not null and ${t.endedAt} >= ${t.createdAt})`),
  check("commission_proposals_deadline_check", sql`${t.respondBy} = ${t.createdAt} + interval '72 hours'`),
  check("commission_proposals_note_check", commissionEnvelopeCheck(t.noteEnvelope)),
  check("commission_proposals_actor_check", identifier(t.actorSessionId)), check("commission_proposals_request_check", identifier(t.requestId)),
  check("commission_proposals_version_check", sql`${t.version} > 0`),
]);

export const commissionDisputes = pgTable("commission_disputes", {
  id: uuid("id").primaryKey().defaultRandom(), orderId: uuid("order_id").notNull().references(() => commissionOrders.id, reference),
  openerUserId: text("opener_user_id").notNull().references(() => identityUsers.id, reference), openerRole: text("opener_role").notNull(),
  trigger: text("trigger").notNull(), triggerAt: time("trigger_at").notNull(), reason: text("reason").notNull(),
  requestedOutcome: text("requested_outcome").notNull(), requestedRefundVnd: bigint("requested_refund_vnd", { mode: "number" }).notNull(),
  orderStateAtOpen: text("order_state_at_open").notNull(), remainingReviewMs: bigint("remaining_review_ms", { mode: "number" }),
  respondBy: time("respond_by").notNull(), state: text("state").notNull().default("open"), openedAt: time("opened_at").notNull(), closedAt: time("closed_at"),
  version: integer("version").notNull().default(1),
}, (t) => [
  uniqueIndex("commission_disputes_open_uidx").on(t.orderId).where(sql`${t.state} = 'open'`),
  index("commission_disputes_order_idx").on(t.orderId, t.openedAt), index("commission_disputes_deadline_idx").on(t.state, t.respondBy),
  check("commission_disputes_role_check", sql`${t.openerRole} in ('buyer','creator')`),
  check("commission_disputes_trigger_check", sql`${t.trigger} in ('final_delivery','overdue','proposal_declined') and ${t.triggerAt} <= ${t.openedAt}`),
  check("commission_disputes_reason_check", sql`${t.reason} in ('not_delivered','not_as_agreed','incomplete_delivery','creator_cannot_complete','communication_breakdown','other')`),
  check("commission_disputes_outcome_check", sql`${t.requestedOutcome} in ('complete','close') and ${t.requestedRefundVnd} between 0 and 50000000`),
  check("commission_disputes_review_check", sql`(${t.orderStateAtOpen} = 'in_progress' and ${t.remainingReviewMs} is null)
    or (${t.orderStateAtOpen} = 'delivered' and ${t.remainingReviewMs} is not null and ${t.remainingReviewMs} >= 0)`),
  check("commission_disputes_state_check", sql`(${t.state} = 'open' and ${t.closedAt} is null)
    or (${t.state} in ('withdrawn','settled','ruled','superseded') and ${t.closedAt} is not null and ${t.closedAt} >= ${t.openedAt})`),
  check("commission_disputes_deadline_check", sql`${t.respondBy} >= ${t.openedAt} + interval '5 days' and ${t.respondBy} <= ${t.openedAt} + interval '14 days'`),
  check("commission_disputes_version_check", sql`${t.version} > 0`),
]);

export const commissionDisputeStatements = pgTable("commission_dispute_statements", {
  id: uuid("id").primaryKey().defaultRandom(), disputeId: uuid("dispute_id").notNull().references(() => commissionDisputes.id, reference),
  authorUserId: text("author_user_id").notNull().references(() => identityUsers.id, reference), authorRole: text("author_role").notNull(), kind: text("kind").notNull(),
  textEnvelope: jsonb("text_envelope").$type<EncryptionEnvelope<"commission_dispute_statements", "text">>().notNull(),
  requestedOutcome: text("requested_outcome"), requestedRefundVnd: bigint("requested_refund_vnd", { mode: "number" }),
  actorSessionId: text("actor_session_id").notNull(), requestId: text("request_id").notNull(), createdAt: time("created_at").notNull(),
  version: integer("version").notNull().default(1),
}, (t) => [
  index("commission_dispute_statements_timeline_idx").on(t.disputeId, t.createdAt, t.id),
  check("commission_dispute_statements_role_check", sql`${t.authorRole} in ('buyer','creator','owner')`),
  check("commission_dispute_statements_kind_check", sql`${t.kind} in ('opening','response','statement','question')`),
  check("commission_dispute_statements_outcome_check", sql`(${t.requestedOutcome} is null and ${t.requestedRefundVnd} is null)
    or (${t.requestedOutcome} is not null and ${t.requestedOutcome} in ('complete','close') and ${t.requestedRefundVnd} is not null and ${t.requestedRefundVnd} between 0 and 50000000)`),
  check("commission_dispute_statements_text_check", commissionEnvelopeCheck(t.textEnvelope)),
  check("commission_dispute_statements_actor_check", identifier(t.actorSessionId)), check("commission_dispute_statements_request_check", identifier(t.requestId)),
  check("commission_dispute_statements_version_check", sql`${t.version} = 1`),
]);

export const commissionRulings = pgTable("commission_rulings", {
  id: uuid("id").primaryKey().defaultRandom(), disputeId: uuid("dispute_id").notNull().references(() => commissionDisputes.id, reference),
  outcome: text("outcome").notNull(), refundAmountVnd: bigint("refund_amount_vnd", { mode: "number" }).notNull(),
  reasoningEnvelope: jsonb("reasoning_envelope").$type<EncryptionEnvelope<"commission_rulings", "reasoning">>().notNull(),
  internalNoteEnvelope: jsonb("internal_note_envelope").$type<EncryptionEnvelope<"commission_rulings", "internal_note">>(),
  policyRevisionId: uuid("policy_revision_id").notNull().references(() => commissionPolicyRevisions.id, reference),
  ownerUserId: text("owner_user_id").notNull().references(() => identityUsers.id, reference), actorSessionId: text("actor_session_id").notNull(),
  stepUpProofId: text("step_up_proof_id").notNull(), requestId: text("request_id").notNull(), ruledAt: time("ruled_at").notNull(),
  version: integer("version").notNull().default(1),
}, (t) => [
  uniqueIndex("commission_rulings_dispute_uidx").on(t.disputeId),
  check("commission_rulings_outcome_check", sql`${t.outcome} in ('complete','close') and ${t.refundAmountVnd} between 0 and 50000000`),
  check("commission_rulings_text_check", sql`${commissionEnvelopeCheck(t.reasoningEnvelope)} and (${t.internalNoteEnvelope} is null or ${commissionEnvelopeCheck(t.internalNoteEnvelope)})`),
  check("commission_rulings_actor_check", identifier(t.actorSessionId)), check("commission_rulings_proof_check", identifier(t.stepUpProofId)),
  check("commission_rulings_request_check", identifier(t.requestId)), check("commission_rulings_version_check", sql`${t.version} = 1`),
]);

export const commissionRulingCorrections = pgTable("commission_ruling_corrections", {
  id: uuid("id").primaryKey().defaultRandom(), rulingId: uuid("ruling_id").notNull().references(() => commissionRulings.id, reference),
  refundAmountVnd: bigint("refund_amount_vnd", { mode: "number" }).notNull(),
  reasonEnvelope: jsonb("reason_envelope").$type<EncryptionEnvelope<"commission_ruling_corrections", "reason">>().notNull(), effect: text("effect").notNull(),
  ownerUserId: text("owner_user_id").notNull().references(() => identityUsers.id, reference), actorSessionId: text("actor_session_id").notNull(),
  stepUpProofId: text("step_up_proof_id").notNull(), requestId: text("request_id").notNull(), correctedAt: time("corrected_at").notNull(),
  version: integer("version").notNull().default(1),
}, (t) => [
  index("commission_ruling_corrections_timeline_idx").on(t.rulingId, t.correctedAt, t.id),
  check("commission_ruling_corrections_amount_check", sql`${t.refundAmountVnd} between 0 and 50000000`),
  check("commission_ruling_corrections_effect_check", sql`${t.effect} in ('increased','reduced','waived','recorded_only')`),
  check("commission_ruling_corrections_reason_check", commissionEnvelopeCheck(t.reasonEnvelope)),
  check("commission_ruling_corrections_actor_check", identifier(t.actorSessionId)), check("commission_ruling_corrections_proof_check", identifier(t.stepUpProofId)),
  check("commission_ruling_corrections_request_check", identifier(t.requestId)), check("commission_ruling_corrections_version_check", sql`${t.version} = 1`),
]);

export const commissionLatePaymentClaims = pgTable("commission_late_payment_claims", {
  id: uuid("id").primaryKey().defaultRandom(), orderId: uuid("order_id").notNull().references(() => commissionOrders.id, reference),
  buyerUserId: text("buyer_user_id").notNull().references(() => identityUsers.id, reference), transferAt: time("transfer_at").notNull(),
  claimedAmountVnd: bigint("claimed_amount_vnd", { mode: "number" }).notNull(),
  referenceEnvelope: jsonb("reference_envelope").$type<EncryptionEnvelope<"commission_late_payment_claims", "bank_reference">>().notNull(),
  noteEnvelope: jsonb("note_envelope").$type<EncryptionEnvelope<"commission_late_payment_claims", "note">>(),
  state: text("state").notNull().default("awaiting_creator"), creatorRespondBy: time("creator_respond_by").notNull(),
  receivedAmountVnd: bigint("received_amount_vnd", { mode: "number" }), filedAt: time("filed_at").notNull(), endedAt: time("ended_at"),
  version: integer("version").notNull().default(1),
}, (t) => [
  uniqueIndex("commission_late_payment_claims_order_uidx").on(t.orderId), index("commission_late_payment_claims_deadline_idx").on(t.state, t.creatorRespondBy),
  check("commission_late_payment_claims_amount_check", sql`${t.claimedAmountVnd} between 1 and 50000000
    and (${t.receivedAmountVnd} is null or ${t.receivedAmountVnd} between 1 and 50000000)`),
  check("commission_late_payment_claims_state_check", sql`(${t.state} = 'awaiting_creator' and ${t.endedAt} is null and ${t.receivedAmountVnd} is null)
    or (${t.state} = 'escalated' and ${t.endedAt} is null and ${t.receivedAmountVnd} is null)
    or (${t.state} = 'refund_owed' and ${t.endedAt} is not null and ${t.receivedAmountVnd} is not null)
    or (${t.state} = 'rejected' and ${t.endedAt} is not null and ${t.receivedAmountVnd} is null)`),
  check("commission_late_payment_claims_time_check", sql`${t.transferAt} <= ${t.filedAt} and ${t.creatorRespondBy} = ${t.filedAt} + interval '5 days'
    and (${t.endedAt} is null or ${t.endedAt} >= ${t.filedAt})`),
  check("commission_late_payment_claims_text_check", sql`${commissionEnvelopeCheck(t.referenceEnvelope)} and (${t.noteEnvelope} is null or ${commissionEnvelopeCheck(t.noteEnvelope)})`),
  check("commission_late_payment_claims_version_check", sql`${t.version} > 0`),
]);

export const commissionResolutionPauses = pgTable("commission_resolution_pauses", {
  id: uuid("id").primaryKey(), startedAt: time("started_at").notNull(), endedAt: time("ended_at"), version: integer("version").notNull().default(1),
}, (t) => [
  uniqueIndex("commission_resolution_pauses_open_uidx").on(sql`(true)`).where(sql`${t.endedAt} is null`),
  check("commission_resolution_pauses_time_check", sql`${t.endedAt} is null or ${t.endedAt} >= ${t.startedAt}`),
  check("commission_resolution_pauses_version_check", sql`${t.version} > 0`),
]);
