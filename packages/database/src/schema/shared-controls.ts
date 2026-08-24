import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

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
