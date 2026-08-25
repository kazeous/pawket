import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Drizzle Kit requires this extensionless TypeScript schema import.
// @ts-ignore Drizzle Kit 0.31 resolves this TypeScript schema only without the emitted .js suffix.
import { identityUsers } from "./identity-core";

type Envelope = { version: 1; algorithm: "A256GCM"; keyId: string; nonce: string; ciphertext: string; authenticationTag: string };

export const creatorApplications = pgTable("creator_applications", {
  id: uuid("id").primaryKey(),
  userId: text("user_id").notNull().references(() => identityUsers.id, { onDelete: "restrict", onUpdate: "restrict" }),
  state: text("state").notNull(), version: integer("version").notNull().default(1),
  currentRevisionId: uuid("current_revision_id"), rejectedAt: timestamp("rejected_at", { withTimezone: true, mode: "date" }),
  cooldownUntil: timestamp("cooldown_until", { withTimezone: true, mode: "date" }),
  reviewerUserId: text("reviewer_user_id").references(() => identityUsers.id, { onDelete: "restrict", onUpdate: "restrict" }),
  reviewClaimedAt: timestamp("review_claimed_at", { withTimezone: true, mode: "date" }),
  reviewClaimExpiresAt: timestamp("review_claim_expires_at", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(), updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
}, (t) => [
  index("creator_applications_user_idx").on(t.userId, t.updatedAt),
  uniqueIndex("creator_applications_one_nonterminal_uidx").on(t.userId).where(sql`${t.state} in ('draft','submitted','under_review','changes_requested')`),
  check("creator_applications_state_check", sql`${t.state} in ('draft','submitted','under_review','changes_requested','approved','rejected','withdrawn')`),
  check("creator_applications_version_check", sql`${t.version} > 0`),
  check("creator_applications_cooldown_check", sql`(${t.state} = 'rejected' and ${t.rejectedAt} is not null and ${t.cooldownUntil} is not null) or (${t.state} <> 'rejected' and ${t.rejectedAt} is null and ${t.cooldownUntil} is null)`),
  check("creator_applications_review_claim_check", sql`(${t.state} = 'under_review' and ${t.reviewerUserId} is not null and ${t.reviewClaimedAt} is not null and ${t.reviewClaimExpiresAt} > ${t.reviewClaimedAt}) or (${t.state} <> 'under_review' and ${t.reviewerUserId} is null and ${t.reviewClaimedAt} is null and ${t.reviewClaimExpiresAt} is null)`),
]);

export const creatorApplicationRevisions = pgTable("creator_application_revisions", {
  id: uuid("id").primaryKey(), applicationId: uuid("application_id").notNull().references(() => creatorApplications.id, { onDelete: "restrict", onUpdate: "restrict" }),
  revisionNumber: integer("revision_number").notNull(), artistDisplayName: text("artist_display_name"), shortIntroduction: text("short_introduction"),
  applicantEmail: text("applicant_email"), dobEnvelope: jsonb("dob_envelope").$type<Envelope | null>(), portfolioUrls: jsonb("portfolio_urls").$type<string[] | null>(),
  primaryArtDiscipline: text("primary_art_discipline"), practiceDescription: text("practice_description"), contentIntent: text("content_intent"), proposedReceivingAccountId: text("proposed_receiving_account_id"),
  ageAtSubmission: integer("age_at_submission"), ageEvaluatedOn: text("age_evaluated_on"), submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "date" }), minimizedAt: timestamp("minimized_at", { withTimezone: true, mode: "date" }), createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(), updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
}, (t) => [
  uniqueIndex("creator_application_revisions_number_uidx").on(t.applicationId, t.revisionNumber),
  index("creator_application_revisions_app_idx").on(t.applicationId),
  check("creator_application_revisions_content_intent_check", sql`${t.contentIntent} is null or ${t.contentIntent} in ('general_audience_only','may_include_age_restricted')`),
  check("creator_application_revisions_minimized_check", sql`${t.minimizedAt} is null or (${t.artistDisplayName} is null and ${t.applicantEmail} is null and ${t.dobEnvelope} is null and ${t.portfolioUrls} is null and ${t.shortIntroduction} is null and ${t.primaryArtDiscipline} is null and ${t.practiceDescription} is null and ${t.contentIntent} is null and ${t.proposedReceivingAccountId} is null)`),
]);

export const creatorApplicationAttestations = pgTable("creator_application_attestations", {
  id: uuid("id").primaryKey(), revisionId: uuid("revision_id").notNull().references(() => creatorApplicationRevisions.id, { onDelete: "restrict", onUpdate: "restrict" }), type: text("type").notNull(), policyVersion: text("policy_version").notNull(), acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "date" }).notNull(), actorUserId: text("actor_user_id").notNull().references(() => identityUsers.id, { onDelete: "restrict", onUpdate: "restrict" }),
}, (t) => [uniqueIndex("creator_application_attestations_revision_type_uidx").on(t.revisionId, t.type), check("creator_application_attestations_type_check", sql`${t.type} in ('dob_truthfulness','portfolio_rights','truthful_information','creator_terms','privacy')`)]);

export const creatorApplicationDecisions = pgTable("creator_application_decisions", {
  id: uuid("id").primaryKey(), applicationId: uuid("application_id").notNull().references(() => creatorApplications.id, { onDelete: "restrict", onUpdate: "restrict" }),
  revisionId: uuid("revision_id").notNull().references(() => creatorApplicationRevisions.id, { onDelete: "restrict", onUpdate: "restrict" }),
  action: text("action").notNull(), reasonCode: text("reason_code").notNull(), applicantExplanation: text("applicant_explanation").notNull(), privateNote: text("private_note"),
  actorUserId: text("actor_user_id").notNull().references(() => identityUsers.id, { onDelete: "restrict", onUpdate: "restrict" }), actorSessionId: text("actor_session_id").notNull(), stepUpProofId: uuid("step_up_proof_id").notNull(), expectedVersion: integer("expected_version").notNull(), requestId: text("request_id").notNull(), createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
}, (t) => [
  index("creator_application_decisions_application_idx").on(t.applicationId, t.createdAt),
  check("creator_application_decisions_action_check", sql`${t.action} in ('changes_requested','approved','rejected','reopened')`),
  check("creator_application_decisions_reason_check", sql`${t.reasonCode} in ('portfolio_insufficient','portfolio_control_unclear','contact_unverified','receiving_account_unverified','content_policy_risk','information_inconsistent','eligibility_not_met','other')`),
  check("creator_application_decisions_text_check", sql`length(${t.applicantExplanation}) between 1 and 2000 and (${t.privateNote} is null or length(${t.privateNote}) between 1 and 1000) and ${t.expectedVersion} > 0`),
]);

export const identityCreatorCapabilities = pgTable("identity_creator_capabilities", {
  id: uuid("id").primaryKey(), userId: text("user_id").notNull().references(() => identityUsers.id, { onDelete: "restrict", onUpdate: "restrict" }),
  state: text("state").notNull(), version: integer("version").notNull().default(1),
  approvedApplicationId: uuid("approved_application_id").notNull().references(() => creatorApplications.id, { onDelete: "restrict", onUpdate: "restrict" }),
  approvedRevisionId: uuid("approved_revision_id").notNull().references(() => creatorApplicationRevisions.id, { onDelete: "restrict", onUpdate: "restrict" }),
  suspendedAt: timestamp("suspended_at", { withTimezone: true, mode: "date" }), createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(), updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
}, (t) => [uniqueIndex("identity_creator_capabilities_user_uidx").on(t.userId), check("identity_creator_capabilities_state_check", sql`${t.state} in ('active','suspended')`), check("identity_creator_capabilities_version_check", sql`${t.version} > 0`), check("identity_creator_capabilities_suspension_check", sql`(${t.state} = 'suspended' and ${t.suspendedAt} is not null) or (${t.state} = 'active' and ${t.suspendedAt} is null)`)]);

export const identityCreatorCapabilityEvents = pgTable("identity_creator_capability_events", {
  id: uuid("id").primaryKey(), capabilityId: uuid("capability_id").notNull().references(() => identityCreatorCapabilities.id, { onDelete: "restrict", onUpdate: "restrict" }),
  action: text("action").notNull(), state: text("state").notNull(), version: integer("version").notNull(), actorUserId: text("actor_user_id").notNull().references(() => identityUsers.id, { onDelete: "restrict", onUpdate: "restrict" }), actorSessionId: text("actor_session_id").notNull(), stepUpProofId: uuid("step_up_proof_id").notNull(), reasonCode: text("reason_code").notNull(), requestId: text("request_id").notNull(), createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
}, (t) => [index("identity_creator_capability_events_capability_idx").on(t.capabilityId, t.createdAt), check("identity_creator_capability_events_action_check", sql`${t.action} in ('granted','suspended','reinstated')`), check("identity_creator_capability_events_state_check", sql`${t.state} in ('active','suspended')`), check("identity_creator_capability_events_version_check", sql`${t.version} > 0`)]);
