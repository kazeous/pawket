import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const systemRetentionRuns = pgTable(
  "system_retention_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    policyVersion: text("policy_version").notNull(),
    mode: text("mode").notNull(),
    dataset: text("dataset").notNull(),
    cutoff: timestamp("cutoff", { withTimezone: true, mode: "date" }).notNull(),
    candidateCount: integer("candidate_count").notNull(),
    protectedCount: integer("protected_count").notNull(),
    processedCount: integer("processed_count").notNull(),
    outcome: text("outcome").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    index("system_retention_runs_started_idx").on(table.startedAt),
    check("system_retention_runs_mode_check", sql`${table.mode} in ('report_only', 'enforce')`),
    check("system_retention_runs_dataset_check", sql`${table.dataset} in ('provisional_accounts', 'verifications', 'sessions', 'receiving_accounts', 'application_content', 'security_throttles')`),
    check("system_retention_runs_outcome_check", sql`${table.outcome} in ('completed', 'paused', 'failed')`),
    check("system_retention_runs_counts_check", sql`${table.candidateCount} >= 0 and ${table.protectedCount} >= 0 and ${table.processedCount} >= 0 and ${table.processedCount} <= ${table.candidateCount}`),
    check("system_retention_runs_time_check", sql`${table.completedAt} >= ${table.startedAt}`),
  ],
);

export const systemRetentionHolds = pgTable(
  "system_retention_holds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dataset: text("dataset").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    reasonCategory: text("reason_category").notNull(),
    referenceId: text("reference_id").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true, mode: "date" }).notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    uniqueIndex("system_retention_holds_active_subject_uidx")
      .on(table.dataset, table.subjectType, table.subjectId)
      .where(sql`${table.releasedAt} is null`),
    check(
      "system_retention_holds_dataset_check",
      sql`${table.dataset} in ('provisional_accounts', 'verifications', 'sessions', 'security_throttles', 'receiving_accounts', 'application_content')`,
    ),
    check(
      "system_retention_holds_subject_type_check",
      sql`${table.subjectType} in ('user', 'verification', 'session', 'security_throttle', 'receiving_account', 'creator_application')`,
    ),
    check(
      "system_retention_holds_dataset_subject_check",
      sql`(${table.dataset} = 'provisional_accounts' and ${table.subjectType} = 'user')
        or (${table.dataset} = 'verifications' and ${table.subjectType} in ('user', 'verification'))
        or (${table.dataset} = 'sessions' and ${table.subjectType} in ('user', 'session'))
        or (${table.dataset} = 'security_throttles' and ${table.subjectType} = 'security_throttle')
        or (${table.dataset} = 'receiving_accounts' and ${table.subjectType} in ('user', 'receiving_account'))
        or (${table.dataset} = 'application_content' and ${table.subjectType} in ('user', 'creator_application'))`,
    ),
    check(
      "system_retention_holds_reason_category_check",
      sql`${table.reasonCategory} in ('incident', 'legal')`,
    ),
    check(
      "system_retention_holds_release_check",
      sql`${table.releasedAt} is null or ${table.releasedAt} > ${table.startsAt}`,
    ),
  ],
);

export const adminAuditEvents = pgTable(
  "admin_audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: text("actor_user_id").notNull(),
    actorSessionId: text("actor_session_id"),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    action: text("action").notNull(),
    outcome: text("outcome").notNull(),
    reasonCode: text("reason_code"),
    beforeState: jsonb("before_state").$type<Record<string, unknown> | null>(),
    afterState: jsonb("after_state").$type<Record<string, unknown> | null>(),
    assurance: jsonb("assurance").$type<Record<string, unknown>>().notNull(),
    applicationRevision: text("application_revision").notNull(),
    requestId: text("request_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    index("admin_audit_events_subject_idx").on(
      table.subjectType,
      table.subjectId,
      table.occurredAt,
    ),
    index("admin_audit_events_actor_idx").on(table.actorUserId, table.occurredAt),
    check(
      "admin_audit_events_outcome_check",
      sql`${table.outcome} in ('succeeded', 'denied', 'failed')`,
    ),
  ],
);

export const systemCommandIdempotency = pgTable(
  "system_command_idempotency",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: text("actor_user_id").notNull(),
    commandScope: text("command_scope").notNull(),
    keyHash: text("key_hash").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    status: text("status").notNull().default("in_progress"),
    resultReference: text("result_reference"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    uniqueIndex("system_command_idempotency_actor_scope_key_uidx").on(
      table.actorUserId,
      table.commandScope,
      table.keyHash,
    ),
    index("system_command_idempotency_expiry_idx").on(table.expiresAt),
    check(
      "system_command_idempotency_status_check",
      sql`${table.status} in ('in_progress', 'completed')`,
    ),
    check(
      "system_command_idempotency_completion_check",
      sql`(${table.status} = 'in_progress' and ${table.completedAt} is null and ${table.resultReference} is null)
        or (${table.status} = 'completed' and ${table.completedAt} is not null and ${table.resultReference} is not null)`,
    ),
    check(
      "system_command_idempotency_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
);

export const systemBusinessCalendarVersions = pgTable(
  "system_business_calendar_versions",
  {
    version: text("version").primaryKey(),
    jurisdiction: text("jurisdiction").notNull().default("VN"),
    timeZone: text("time_zone").notNull().default("Asia/Ho_Chi_Minh"),
    sourceLabel: text("source_label").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" }).notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    check(
      "system_business_calendar_versions_vn_check",
      sql`${table.jurisdiction} = 'VN' and ${table.timeZone} = 'Asia/Ho_Chi_Minh'`,
    ),
  ],
);

export const systemBusinessCalendarHolidays = pgTable(
  "system_business_calendar_holidays",
  {
    calendarVersion: text("calendar_version")
      .notNull()
      .references(() => systemBusinessCalendarVersions.version, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    holidayDate: date("holiday_date", { mode: "string" }).notNull(),
    name: text("name").notNull(),
  },
  (table) => [
    primaryKey({
      name: "system_business_calendar_holidays_pk",
      columns: [table.calendarVersion, table.holidayDate],
    }),
    index("system_business_calendar_holidays_date_idx").on(table.holidayDate),
  ],
);
