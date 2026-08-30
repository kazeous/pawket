import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Drizzle Kit resolves schema sources without emitted extensions.
// @ts-ignore Drizzle Kit 0.31 resolves this TypeScript schema only without the emitted .js suffix.
import { creatorPublicationRevisions } from "./creator-catalog";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Drizzle Kit resolves schema sources without emitted extensions.
// @ts-ignore Drizzle Kit 0.31 resolves this TypeScript schema only without the emitted .js suffix.
import { identityUsers } from "./identity-core";

const reasons = "'impersonation','prohibited_or_age_restricted_content','harassment_or_hate','violence_or_self_harm','privacy','intellectual_property','spam_or_scam','other'";
const states = "'open','dismissed','held','closed'";
const hmacPattern = "^hmac-sha256:v1:[A-Za-z0-9_-]{43}$";
const hashPattern = "^sha256:v1:[A-Za-z0-9_-]{43}$";

export const publicContentReports = pgTable("public_content_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  reportReference: text("report_reference").notNull(),
  targetType: text("target_type").notNull(),
  targetId: uuid("target_id").notNull(),
  publicationRevisionId: uuid("publication_revision_id").notNull().references(
    () => creatorPublicationRevisions.id,
    { onDelete: "restrict", onUpdate: "restrict" },
  ),
  reason: text("reason").notNull(),
  detail: text("detail"),
  reporterUserId: text("reporter_user_id").references(() => identityUsers.id, {
    onDelete: "restrict",
    onUpdate: "restrict",
  }),
  state: text("state").notNull().default("open"),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
}, (table) => [
  uniqueIndex("public_content_reports_reference_uidx").on(table.reportReference),
  index("public_content_reports_queue_idx").on(table.state, table.createdAt, table.id),
  index("public_content_reports_duplicate_idx").on(table.targetType, table.targetId, table.publicationRevisionId, table.reporterUserId),
  uniqueIndex("public_content_reports_authenticated_target_uidx").on(
    table.targetType,
    table.targetId,
    table.publicationRevisionId,
    table.reporterUserId,
  ).where(sql`${table.reporterUserId} is not null`),
  check("public_content_reports_reference_check", sql`char_length(${table.reportReference}) between 24 and 128 and ${table.reportReference} ~ '^report:v1:[A-Za-z0-9_-]+$'`),
  check("public_content_reports_target_type_check", sql`${table.targetType} in ('page','showcase')`),
  check("public_content_reports_reason_check", sql`${table.reason} in (${sql.raw(reasons)})`),
  check("public_content_reports_detail_check", sql`${table.detail} is null or (char_length(${table.detail}) between 0 and 1000 and ${table.detail} !~ '[[:cntrl:]]' and normalize(${table.detail}) = ${table.detail})`),
  check("public_content_reports_state_check", sql`${table.state} in (${sql.raw(states)})`),
  check("public_content_reports_version_check", sql`${table.version} > 0`),
  check("public_content_reports_time_check", sql`${table.updatedAt} >= ${table.createdAt}`),
]);

export const publicReportChallenges = pgTable("public_report_challenges", {
  id: uuid("id").primaryKey().defaultRandom(),
  tokenHash: text("token_hash").notNull(),
  networkKeyHmac: text("network_key_hmac").notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true, mode: "date" }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
}, (table) => [
  uniqueIndex("public_report_challenges_token_hash_uidx").on(table.tokenHash),
  index("public_report_challenges_expiry_idx").on(table.expiresAt, table.id),
  check("public_report_challenges_token_hash_check", sql`${table.tokenHash} ~ '${sql.raw(hashPattern)}'`),
  check("public_report_challenges_network_hmac_check", sql`${table.networkKeyHmac} ~ '${sql.raw(hmacPattern)}'`),
  check("public_report_challenges_lifetime_check", sql`${table.expiresAt} = ${table.issuedAt} + interval '10 minutes'`),
  check("public_report_challenges_consumption_check", sql`${table.consumedAt} is null or (${table.consumedAt} >= ${table.issuedAt} and ${table.consumedAt} <= ${table.expiresAt})`),
]);

export const publicReportSecurityEvents = pgTable("public_report_security_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  requesterKind: text("requester_kind").notNull(),
  networkKeyHmac: text("network_key_hmac"),
  actorUserId: text("actor_user_id").references(() => identityUsers.id, {
    onDelete: "restrict",
    onUpdate: "restrict",
  }),
  targetHash: text("target_hash").notNull(),
  revisionHash: text("revision_hash").notNull(),
  outcome: text("outcome").notNull(),
  outcomeCategory: text("outcome_category").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
}, (table) => [
  index("public_report_security_events_expiry_idx").on(table.expiresAt, table.id),
  index("public_report_security_events_network_idx").on(table.networkKeyHmac, table.createdAt).where(sql`${table.networkKeyHmac} is not null`),
  index("public_report_security_events_actor_idx").on(table.actorUserId, table.createdAt).where(sql`${table.actorUserId} is not null`),
  index("public_report_security_events_target_idx").on(table.targetHash, table.revisionHash, table.createdAt),
  check("public_report_security_events_requester_check", sql`(${table.requesterKind} = 'guest' and ${table.networkKeyHmac} is not null and ${table.actorUserId} is null) or (${table.requesterKind} = 'authenticated' and ${table.networkKeyHmac} is null and ${table.actorUserId} is not null)`),
  check("public_report_security_events_network_hmac_check", sql`${table.networkKeyHmac} is null or ${table.networkKeyHmac} ~ '${sql.raw(hmacPattern)}'`),
  check("public_report_security_events_target_hash_check", sql`${table.targetHash} ~ '${sql.raw(hashPattern)}' and ${table.revisionHash} ~ '${sql.raw(hashPattern)}'`),
  check("public_report_security_events_outcome_check", sql`${table.outcome} in ('accepted','rejected')`),
  check("public_report_security_events_category_check", sql`(${table.outcome} = 'accepted' and ${table.outcomeCategory} = 'accepted') or (${table.outcome} = 'rejected' and ${table.outcomeCategory} in ('invalid_target','invalid_challenge','rate_limited','duplicate'))`),
  check("public_report_security_events_expiry_check", sql`${table.expiresAt} > ${table.createdAt} and ${table.expiresAt} <= ${table.createdAt} + interval '24 hours'`),
]);

export const publicVisibilityHolds = pgTable("public_visibility_holds", {
  id: uuid("id").primaryKey().defaultRandom(),
  reportId: uuid("report_id").notNull().references(() => publicContentReports.id, { onDelete: "restrict", onUpdate: "restrict" }),
  targetType: text("target_type").notNull(),
  targetId: uuid("target_id").notNull(),
  publicationRevisionId: uuid("publication_revision_id").notNull().references(
    () => creatorPublicationRevisions.id,
    { onDelete: "restrict", onUpdate: "restrict" },
  ),
  reason: text("reason").notNull(),
  actorUserId: text("actor_user_id").notNull().references(() => identityUsers.id, { onDelete: "restrict", onUpdate: "restrict" }),
  actorSessionId: text("actor_session_id").notNull(),
  requestId: text("request_id").notNull(),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  releasedAt: timestamp("released_at", { withTimezone: true, mode: "date" }),
  releasedByUserId: text("released_by_user_id").references(() => identityUsers.id, { onDelete: "restrict", onUpdate: "restrict" }),
  releasedBySessionId: text("released_by_session_id"),
  releaseReason: text("release_reason"),
  releaseRequestId: text("release_request_id"),
}, (table) => [
  uniqueIndex("public_visibility_holds_active_target_uidx").on(table.targetType, table.targetId).where(sql`${table.releasedAt} is null`),
  index("public_visibility_holds_report_idx").on(table.reportId, table.createdAt),
  check("public_visibility_holds_target_type_check", sql`${table.targetType} in ('page','showcase')`),
  check("public_visibility_holds_reason_check", sql`char_length(${table.reason}) between 1 and 200 and ${table.reason} !~ '[[:cntrl:]]' and normalize(${table.reason}) = ${table.reason}`),
  check("public_visibility_holds_actor_check", sql`char_length(${table.actorSessionId}) between 1 and 256 and char_length(${table.requestId}) between 1 and 256`),
  check("public_visibility_holds_version_check", sql`${table.version} > 0`),
  check("public_visibility_holds_release_check", sql`(${table.releasedAt} is null and ${table.releasedByUserId} is null and ${table.releasedBySessionId} is null and ${table.releaseReason} is null and ${table.releaseRequestId} is null) or (${table.releasedAt} is not null and ${table.releasedAt} > ${table.createdAt} and ${table.releasedByUserId} is not null and char_length(${table.releasedBySessionId}) between 1 and 256 and char_length(${table.releaseReason}) between 1 and 200 and char_length(${table.releaseRequestId}) between 1 and 256)`),
]);

export const publicContentTriageEvents = pgTable("public_content_triage_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  reportId: uuid("report_id").notNull().references(() => publicContentReports.id, { onDelete: "restrict", onUpdate: "restrict" }),
  holdId: uuid("hold_id").references(() => publicVisibilityHolds.id, { onDelete: "restrict", onUpdate: "restrict" }),
  action: text("action").notNull(),
  actorUserId: text("actor_user_id").notNull().references(() => identityUsers.id, { onDelete: "restrict", onUpdate: "restrict" }),
  actorSessionId: text("actor_session_id").notNull(),
  reason: text("reason").notNull(),
  requestId: text("request_id").notNull(),
  expectedReportVersion: integer("expected_report_version").notNull(),
  resultingReportVersion: integer("resulting_report_version").notNull(),
  beforeState: text("before_state").notNull(),
  afterState: text("after_state").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull(),
}, (table) => [
  index("public_content_triage_events_report_idx").on(table.reportId, table.occurredAt, table.id),
  check("public_content_triage_events_action_check", sql`${table.action} in ('dismiss','hide','restore')`),
  check("public_content_triage_events_state_check", sql`${table.beforeState} in (${sql.raw(states)}) and ${table.afterState} in (${sql.raw(states)})`),
  check("public_content_triage_events_version_check", sql`${table.expectedReportVersion} > 0 and ${table.resultingReportVersion} = ${table.expectedReportVersion} + 1`),
  check("public_content_triage_events_text_check", sql`char_length(${table.actorSessionId}) between 1 and 256 and char_length(${table.reason}) between 1 and 200 and char_length(${table.requestId}) between 1 and 256 and ${table.reason} !~ '[[:cntrl:]]' and normalize(${table.reason}) = ${table.reason}`),
  check("public_content_triage_events_transition_check", sql`(${table.action} = 'dismiss' and ${table.holdId} is null and ${table.beforeState} = 'open' and ${table.afterState} = 'dismissed') or (${table.action} = 'hide' and ${table.holdId} is not null and ${table.beforeState} = 'open' and ${table.afterState} = 'held') or (${table.action} = 'restore' and ${table.holdId} is not null and ${table.beforeState} = 'held' and ${table.afterState} = 'closed')`),
]);
