import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { identityUsers } from "./identity-core.js";

type Envelope = { version: 1; algorithm: "A256GCM"; keyId: string; nonce: string; ciphertext: string; authenticationTag: string };

export const creatorApplications = pgTable("creator_applications", {
  id: uuid("id").primaryKey(),
  userId: text("user_id").notNull().references(() => identityUsers.id, { onDelete: "restrict", onUpdate: "restrict" }),
  state: text("state").notNull(), version: integer("version").notNull().default(1),
  currentRevisionId: uuid("current_revision_id"), rejectedAt: timestamp("rejected_at", { withTimezone: true, mode: "date" }),
  cooldownUntil: timestamp("cooldown_until", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(), updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
}, (t) => [
  index("creator_applications_user_idx").on(t.userId, t.updatedAt),
  uniqueIndex("creator_applications_one_nonterminal_uidx").on(t.userId).where(sql`${t.state} in ('draft','submitted','under_review','changes_requested')`),
  check("creator_applications_state_check", sql`${t.state} in ('draft','submitted','under_review','changes_requested','rejected','withdrawn')`),
  check("creator_applications_version_check", sql`${t.version} > 0`),
  check("creator_applications_cooldown_check", sql`(${t.state} = 'rejected' and ${t.rejectedAt} is not null and ${t.cooldownUntil} is not null) or (${t.state} <> 'rejected' and ${t.rejectedAt} is null and ${t.cooldownUntil} is null)`),
]);

export const creatorApplicationRevisions = pgTable("creator_application_revisions", {
  id: uuid("id").primaryKey(), applicationId: uuid("application_id").notNull().references(() => creatorApplications.id, { onDelete: "restrict", onUpdate: "restrict" }),
  revisionNumber: integer("revision_number").notNull(), artistDisplayName: text("artist_display_name"), shortIntroduction: text("short_introduction"),
  applicantEmail: text("applicant_email"), dobEnvelope: jsonb("dob_envelope").$type<Envelope | null>(), portfolioUrls: jsonb("portfolio_urls").$type<string[] | null>(),
  primaryArtDiscipline: text("primary_art_discipline"), practiceDescription: text("practice_description"), contentIntent: text("content_intent"), proposedReceivingAccountId: text("proposed_receiving_account_id"),
  ageAtSubmission: integer("age_at_submission"), ageEvaluatedOn: text("age_evaluated_on"), submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "date" }), createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(), updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
}, (t) => [uniqueIndex("creator_application_revisions_number_uidx").on(t.applicationId, t.revisionNumber), index("creator_application_revisions_app_idx").on(t.applicationId), check("creator_application_revisions_content_intent_check", sql`${t.contentIntent} is null or ${t.contentIntent} in ('general_audience_only','may_include_age_restricted')`)]);

export const creatorApplicationAttestations = pgTable("creator_application_attestations", {
  id: uuid("id").primaryKey(), revisionId: uuid("revision_id").notNull().references(() => creatorApplicationRevisions.id, { onDelete: "restrict", onUpdate: "restrict" }), type: text("type").notNull(), policyVersion: text("policy_version").notNull(), acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "date" }).notNull(), actorUserId: text("actor_user_id").notNull().references(() => identityUsers.id, { onDelete: "restrict", onUpdate: "restrict" }),
}, (t) => [uniqueIndex("creator_application_attestations_revision_type_uidx").on(t.revisionId, t.type), check("creator_application_attestations_type_check", sql`${t.type} in ('dob_truthfulness','portfolio_rights','truthful_information','creator_terms','privacy')`)]);
