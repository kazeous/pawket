import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Drizzle Kit requires extensionless schema imports.
// @ts-ignore Drizzle Kit resolves this TypeScript schema without the emitted suffix.
import { identityUsers } from "./identity-core";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Drizzle Kit requires extensionless schema imports.
// @ts-ignore Drizzle Kit resolves this TypeScript schema without the emitted suffix.
import { trustCases } from "./trust-cases";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Drizzle Kit requires extensionless schema imports.
// @ts-ignore Drizzle Kit resolves this TypeScript schema without the emitted suffix.
import { publicContentReports } from "./public-trust";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Drizzle Kit requires extensionless schema imports.
// @ts-ignore Drizzle Kit resolves this TypeScript schema without the emitted suffix.
import { commissionOrders, commissionPackageRevisions, commissionEnvelopeCheck } from "./commissions";

type TrustPolicyKind = "community_rules" | "enforcement_appeals";
const time = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const trustEnforcementPauses = pgTable("trust_enforcement_pauses", {
  id: uuid("id").primaryKey(), startedAt: time("started_at").notNull(), endedAt: time("ended_at"), version: integer("version").notNull().default(1),
}, (t) => [
  uniqueIndex("trust_enforcement_pauses_open_uidx").on(sql`(true)`).where(sql`${t.endedAt} is null`),
  check("trust_enforcement_pauses_time_check", sql`${t.endedAt} is null or ${t.endedAt} >= ${t.startedAt}`),
  check("trust_enforcement_pauses_version_check", sql`${t.version} > 0`),
]);

export const trustPolicyRevisions = pgTable("trust_policy_revisions", {
  id: uuid("id").primaryKey(), kind: text("kind").$type<TrustPolicyKind>().notNull(), revisionNumber: integer("revision_number").notNull(),
  document: text("document").notNull(), approvalKind: text("approval_kind").$type<"synthetic" | "owner_reviewed">().notNull(),
  actorUserId: text("actor_user_id").references(() => identityUsers.id, { onDelete: "restrict", onUpdate: "restrict" }),
  actorSessionId: text("actor_session_id"), checksum: text("checksum").notNull(), source: text("source").notNull(),
  effectiveAt: time("effective_at").notNull(), createdAt: time("created_at").notNull(),
}, (t) => [
  uniqueIndex("trust_policy_revisions_kind_number_uidx").on(t.kind, t.revisionNumber),
  check("trust_policy_revisions_kind_check", sql`${t.kind} in ('community_rules', 'enforcement_appeals')`),
  check("trust_policy_revisions_number_check", sql`${t.revisionNumber} > 0`),
  check("trust_policy_revisions_document_check", sql`char_length(${t.document}) between 1 and 16000
    and ${t.document} = normalize(${t.document}, NFC) and replace(${t.document}, chr(10), '') !~ '[[:cntrl:]]'`),
  check("trust_policy_revisions_approval_check", sql`(${t.approvalKind} = 'synthetic' and ${t.actorUserId} is null and ${t.actorSessionId} is null)
    or (${t.approvalKind} = 'owner_reviewed' and ${t.actorUserId} is not null and ${t.actorSessionId} is not null)`),
  check("trust_policy_revisions_checksum_check", sql`${t.checksum} ~ '^sha256:[a-f0-9]{64}$'`),
  check("trust_policy_revisions_source_check", sql`char_length(${t.source}) between 1 and 200`),
]);

export const trustPolicyCurrent = pgTable("trust_policy_current", {
  kind: text("kind").$type<TrustPolicyKind>().primaryKey(),
  revisionId: uuid("revision_id").notNull().references(() => trustPolicyRevisions.id, { onDelete: "restrict", onUpdate: "restrict" }),
  updatedAt: time("updated_at").notNull(),
}, (t) => [check("trust_policy_current_kind_check", sql`${t.kind} in ('community_rules', 'enforcement_appeals')`)]);

type Envelope = { version: 1; algorithm: "A256GCM"; keyId: string; nonce: string; ciphertext: string; authenticationTag: string };
type PenaltyKind = "warning" | "restriction" | "suspension" | "removal";
type PenaltyState = "active" | "expired" | "lifted" | "reversed" | "reduced";
type Restriction = "commission_intake" | "commission_buying" | "dispute_opening" | "reporting";
type PenaltyTarget = "creator_capability" | "account";
type PenaltyReason = "spam_or_scam" | "harassment_or_hate" | "prohibited_or_age_restricted_content" | "intellectual_property"
  | "privacy" | "impersonation" | "refund_non_compliance" | "dispute_or_report_abuse" | "other";
const reference = { onDelete: "restrict", onUpdate: "restrict" } as const;

export const trustContentHides = pgTable("trust_content_hides", {
  id: uuid("id").primaryKey(), caseId: uuid("case_id").notNull().references(() => trustCases.id, reference),
  targetKind: text("target_kind").$type<"commission_message" | "commission_file" | "commission_package">().notNull(), targetId: uuid("target_id").notNull(),
  orderId: uuid("order_id").references(() => commissionOrders.id, reference),
  contentOwnerUserId: text("content_owner_user_id").notNull().references(() => identityUsers.id, reference),
  hiddenAt: time("hidden_at").notNull(), hiddenByUserId: text("hidden_by_user_id").notNull().references(() => identityUsers.id, reference),
  hiddenBySessionId: text("hidden_by_session_id").notNull(), reasonEnvelope: jsonb("reason_envelope").$type<Envelope>().notNull(), requestId: text("request_id").notNull(),
  releasedAt: time("released_at"), releasedByUserId: text("released_by_user_id").references(() => identityUsers.id, reference),
  releaseKind: text("release_kind").$type<"owner_restore" | "appeal_reversed">(), releaseRequestId: text("release_request_id"),
}, (t) => [
  uniqueIndex("trust_content_hides_active_uidx").on(t.targetKind, t.targetId).where(sql`${t.releasedAt} is null`),
  index("trust_content_hides_case_idx").on(t.caseId, t.hiddenAt, t.id),
  check("trust_content_hides_kind_check", sql`${t.targetKind} in ('commission_message','commission_file','commission_package')`),
  check("trust_content_hides_order_check", sql`(${t.targetKind} = 'commission_package') = (${t.orderId} is null)`),
  check("trust_content_hides_reason_check", commissionEnvelopeCheck(t.reasonEnvelope)),
  check("trust_content_hides_release_check", sql`(${t.releasedAt} is null and ${t.releasedByUserId} is null and ${t.releaseKind} is null and ${t.releaseRequestId} is null)
    or (${t.releasedAt} is not null and ${t.releasedAt} >= ${t.hiddenAt} and ${t.releaseRequestId} is not null
      and ((${t.releaseKind} = 'owner_restore' and ${t.releasedByUserId} is not null) or (${t.releaseKind} = 'appeal_reversed' and ${t.releasedByUserId} is null)))`),
]);

type ReportTargetKind = "commission_package" | "commission_brief" | "commission_message" | "commission_file";
type ReportReason = "impersonation" | "prohibited_or_age_restricted_content" | "harassment_or_hate" | "violence_or_self_harm"
  | "privacy" | "intellectual_property" | "spam_or_scam" | "other";
export const trustReports = pgTable("trust_reports", {
  id: uuid("id").primaryKey(), reportReference: text("report_reference").notNull(), targetKind: text("target_kind").$type<ReportTargetKind>().notNull(),
  targetId: uuid("target_id").notNull(), orderId: uuid("order_id").references(() => commissionOrders.id, reference),
  packageRevisionId: uuid("package_revision_id").references(() => commissionPackageRevisions.id, reference),
  contentOwnerUserId: text("content_owner_user_id").notNull().references(() => identityUsers.id, reference),
  reporterUserId: text("reporter_user_id").references(() => identityUsers.id, reference), reporterNetworkHmac: text("reporter_network_hmac"),
  reason: text("reason").$type<ReportReason>().notNull(), detailEnvelope: jsonb("detail_envelope").$type<Envelope>(),
  caseId: uuid("case_id").notNull().references(() => trustCases.id, reference),
  state: text("state").$type<"open" | "closed">().notNull().default("open"), createdAt: time("created_at").notNull(), closedAt: time("closed_at"),
}, (t) => [
  uniqueIndex("trust_reports_reference_uidx").on(t.reportReference),
  uniqueIndex("trust_reports_actor_target_uidx").on(t.targetKind, t.targetId, t.reporterUserId).where(sql`${t.reporterUserId} is not null`),
  index("trust_reports_filed_idx").on(t.reporterUserId, t.createdAt, t.id).where(sql`${t.reporterUserId} is not null`),
  index("trust_reports_case_idx").on(t.caseId, t.createdAt, t.id),
  check("trust_reports_reference_check", sql`${t.reportReference} ~ '^report:v2:[A-Za-z0-9_-]{32}$'`),
  check("trust_reports_kind_check", sql`${t.targetKind} in ('commission_package','commission_brief','commission_message','commission_file')`),
  check("trust_reports_target_check", sql`(${t.targetKind} = 'commission_package' and ${t.packageRevisionId} is not null and ${t.orderId} is null)
    or (${t.targetKind} <> 'commission_package' and ${t.packageRevisionId} is null and ${t.orderId} is not null)`),
  check("trust_reports_reporter_check", sql`(${t.reporterUserId} is not null) <> (${t.reporterNetworkHmac} is not null)`),
  check("trust_reports_network_check", sql`${t.reporterNetworkHmac} is null or (${t.targetKind} = 'commission_package' and ${t.reporterNetworkHmac} ~ '^hmac-sha256:v1:[A-Za-z0-9_-]{43}$')`),
  check("trust_reports_owner_check", sql`${t.reporterUserId} is null or ${t.reporterUserId} <> ${t.contentOwnerUserId}`),
  check("trust_reports_reason_check", sql`${t.reason} in ('impersonation','prohibited_or_age_restricted_content','harassment_or_hate','violence_or_self_harm','privacy','intellectual_property','spam_or_scam','other')`),
  check("trust_reports_detail_check", sql`${t.detailEnvelope} is null or ${commissionEnvelopeCheck(t.detailEnvelope)}`),
  check("trust_reports_state_check", sql`(${t.state} = 'open' and ${t.closedAt} is null)
    or (${t.state} = 'closed' and ${t.closedAt} is not null and ${t.closedAt} >= ${t.createdAt})`),
]);

export const trustPenalties = pgTable("trust_penalties", {
  id: uuid("id").primaryKey(), subjectUserId: text("subject_user_id").notNull().references(() => identityUsers.id, reference),
  kind: text("kind").$type<PenaltyKind>().notNull(), restriction: text("restriction").$type<Restriction>(),
  target: text("target").$type<PenaltyTarget>(), state: text("state").$type<PenaltyState>().notNull().default("active"),
  reasonCategory: text("reason_category").$type<PenaltyReason>().notNull(),
  explanationEnvelope: jsonb("explanation_envelope").$type<Envelope>().notNull(), internalNoteEnvelope: jsonb("internal_note_envelope").$type<Envelope>(),
  sourceCaseId: uuid("source_case_id").references(() => trustCases.id, reference),
  sourcePublicReportId: uuid("source_public_report_id").references(() => publicContentReports.id, reference),
  enforcementPolicyRevisionId: uuid("enforcement_policy_revision_id").references(() => trustPolicyRevisions.id, reference),
  replacesPenaltyId: uuid("replaces_penalty_id").references((): AnyPgColumn => trustPenalties.id, reference),
  startsAt: time("starts_at").notNull(), endsAt: time("ends_at"), endedAt: time("ended_at"), endReason: text("end_reason"), acknowledgedAt: time("acknowledged_at"),
  ownerUserId: text("owner_user_id").notNull().references(() => identityUsers.id, reference), ownerSessionId: text("owner_session_id").notNull(),
  stepUpProofId: uuid("step_up_proof_id").notNull(), requestId: text("request_id").notNull(), version: integer("version").notNull().default(1),
  createdAt: time("created_at").notNull(),
}, (t) => [
  index("trust_penalties_subject_idx").on(t.subjectUserId, t.createdAt, t.id),
  uniqueIndex("trust_penalties_active_restriction_uidx").on(t.subjectUserId, t.restriction).where(sql`${t.state} = 'active' and ${t.kind} = 'restriction'`),
  uniqueIndex("trust_penalties_active_suspension_uidx").on(t.subjectUserId, t.target).where(sql`${t.state} = 'active' and ${t.kind} = 'suspension'`),
  uniqueIndex("trust_penalties_active_removal_uidx").on(t.subjectUserId, t.target).where(sql`${t.state} = 'active' and ${t.kind} = 'removal'`),
  check("trust_penalties_kind_check", sql`${t.kind} in ('warning','restriction','suspension','removal')`),
  check("trust_penalties_restriction_check", sql`${t.restriction} is null or ${t.restriction} in ('commission_intake','commission_buying','dispute_opening','reporting')`),
  check("trust_penalties_target_check", sql`${t.target} is null or ${t.target} in ('creator_capability','account')`),
  check("trust_penalties_state_check", sql`${t.state} in ('active','expired','lifted','reversed','reduced')`),
  check("trust_penalties_reason_check", sql`${t.reasonCategory} in ('spam_or_scam','harassment_or_hate','prohibited_or_age_restricted_content',
    'intellectual_property','privacy','impersonation','refund_non_compliance','dispute_or_report_abuse','other')`),
  check("trust_penalties_shape_check", sql`(${t.kind} = 'warning' and ${t.restriction} is null and ${t.target} is null and ${t.endsAt} is null)
    or (${t.kind} = 'restriction' and ${t.restriction} is not null and ${t.target} is null)
    or (${t.kind} = 'suspension' and ${t.target} is not null and ${t.restriction} is null)
    or (${t.kind} = 'removal' and ${t.target} is not null and ${t.restriction} is null and ${t.endsAt} is null)`),
  check("trust_penalties_source_check", sql`num_nonnulls(${t.sourceCaseId}, ${t.sourcePublicReportId}) = 1`),
  check("trust_penalties_end_time_check", sql`${t.endsAt} is null or ${t.endsAt} > ${t.startsAt}`),
  check("trust_penalties_ended_check", sql`(${t.state} = 'active') = (${t.endedAt} is null)`),
  check("trust_penalties_acknowledged_check", sql`${t.acknowledgedAt} is null or ${t.kind} = 'warning'`),
  check("trust_penalties_version_check", sql`${t.version} > 0`),
]);

export const trustPenaltyEvents = pgTable("trust_penalty_events", {
  id: uuid("id").primaryKey(), penaltyId: uuid("penalty_id").notNull().references(() => trustPenalties.id, reference),
  action: text("action").$type<"applied" | "expired" | "lifted" | "reversed" | "reduced" | "acknowledged">().notNull(),
  actorUserId: text("actor_user_id").references(() => identityUsers.id, reference), actorSessionId: text("actor_session_id"),
  reasonEnvelope: jsonb("reason_envelope").$type<Envelope>(), requestId: text("request_id").notNull(),
  expectedVersion: integer("expected_version").notNull(), resultingVersion: integer("resulting_version").notNull(), occurredAt: time("occurred_at").notNull(),
}, (t) => [
  index("trust_penalty_events_penalty_idx").on(t.penaltyId, t.occurredAt),
  check("trust_penalty_events_action_check", sql`${t.action} in ('applied','expired','lifted','reversed','reduced','acknowledged')`),
  check("trust_penalty_events_actor_check", sql`(${t.actorUserId} is null) = (${t.actorSessionId} is null)`),
  check("trust_penalty_events_version_check", sql`${t.expectedVersion} >= 0 and ${t.resultingVersion} = ${t.expectedVersion} + 1`),
]);
