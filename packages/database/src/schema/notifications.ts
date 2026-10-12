import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Drizzle Kit requires extensionless schema imports.
// @ts-ignore Drizzle Kit resolves this TypeScript schema without the emitted suffix.
import { identityEmailHandoffs, identityUsers } from "./identity-core";
// The dependency-free policy module shares the catalog without a package dependency cycle.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Drizzle Kit requires extensionless schema imports.
// @ts-ignore Drizzle Kit resolves this TypeScript policy without the emitted suffix.
import { NOTIFICATION_CATEGORIES, NOTIFICATION_CHANNELS, NOTIFICATION_CLOCKS, NOTIFICATION_KINDS, OPTIONAL_EMAIL_CATEGORIES } from "../../../notifications/src/policy";

const time = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const reference = { onDelete: "restrict", onUpdate: "restrict" } as const;
const enumValues = (values: readonly string[]) => sql.join(values.map((value) => sql.raw(`'${value}'`)), sql`, `);
const subjectTypes = ["commission_order", "commission_proposal", "commission_dispute", "commission_late_payment_claim",
  "commission_refund_obligation", "trust_case", "trust_content_hide", "trust_penalty", "trust_appeal", "trust_report",
  "tip", "creator_application", "creator_capability", "verification_deposit"] as const;

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  recipientUserId: text("recipient_user_id").notNull().references(() => identityUsers.id, reference),
  kind: text("kind").notNull(),
  variant: text("variant"),
  category: text("category").notNull(),
  actionRequired: boolean("action_required").notNull(),
  subjectType: text("subject_type").notNull(),
  subjectId: text("subject_id").notNull(),
  linkPath: text("link_path").notNull(),
  collapseKey: text("collapse_key"),
  collapsedCount: integer("collapsed_count").notNull().default(1),
  lastSequence: integer("last_sequence"),
  sourceKey: text("source_key").notNull(),
  emailState: text("email_state").notNull(),
  emailDueAt: time("email_due_at"),
  emailQueuedAt: time("email_queued_at"),
  emailHandoffId: uuid("email_handoff_id").references(() => identityEmailHandoffs.id, reference),
  createdAt: time("created_at").notNull().defaultNow(),
  updatedAt: time("updated_at").notNull().defaultNow(),
  readAt: time("read_at"),
}, (table) => [
  uniqueIndex("notifications_source_recipient_uidx").on(table.sourceKey, table.recipientUserId),
  uniqueIndex("notifications_unread_collapse_uidx").on(table.recipientUserId, table.collapseKey)
    .where(sql`${table.collapseKey} is not null and ${table.readAt} is null`),
  index("notifications_inbox_idx").on(table.recipientUserId, table.createdAt.desc(), table.id.desc()),
  index("notifications_unread_idx").on(table.recipientUserId).where(sql`${table.readAt} is null`),
  index("notifications_pending_email_idx").on(table.emailDueAt).where(sql`${table.emailState} = 'pending'`),
  index("notifications_retention_idx").on(table.createdAt),
  check("notifications_kind_check", sql`${table.kind} in (${enumValues(NOTIFICATION_KINDS)})`),
  check("notifications_variant_check", sql`${table.variant} ~ '^[a-z_]{1,40}$'`),
  check("notifications_category_check", sql`${table.category} in (${enumValues(NOTIFICATION_CATEGORIES)})`),
  check("notifications_subject_type_check", sql`${table.subjectType} in (${enumValues(subjectTypes)})`),
  check("notifications_link_path_check", sql`${table.linkPath} ~ '^/[A-Za-z0-9/_-]{1,200}$'`),
  check("notifications_collapse_key_check", sql`${table.collapseKey} ~ '^messages:[0-9a-f-]{36}$'`),
  check("notifications_collapsed_count_check", sql`${table.collapsedCount} >= 1`),
  check("notifications_last_sequence_check", sql`(${table.lastSequence} is not null) = (${table.collapseKey} is not null)`),
  check("notifications_email_state_check", sql`${table.emailState} in ('none','pending','queued','suppressed','attention_required')`),
  check("notifications_email_due_check", sql`(${table.emailDueAt} is not null) = (${table.emailState} = 'pending')`),
  check("notifications_email_handoff_check", sql`(${table.emailHandoffId} is not null) = (${table.emailState} in ('queued','attention_required'))`),
  check("notifications_read_at_check", sql`${table.readAt} >= ${table.createdAt}`),
]);

export const notificationPreferences = pgTable("notification_preferences", {
  userId: text("user_id").notNull().references(() => identityUsers.id, reference),
  category: text("category").notNull(),
  channel: text("channel").notNull(),
  updatedAt: time("updated_at").notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.category, table.channel] }),
  check("notification_preferences_category_check", sql`${table.category} in (${enumValues(OPTIONAL_EMAIL_CATEGORIES)})`),
  check("notification_preferences_channel_check", sql`${table.channel} in (${enumValues(NOTIFICATION_CHANNELS)})`),
]);

export const notificationReminders = pgTable("notification_reminders", {
  id: uuid("id").primaryKey().defaultRandom(),
  subjectType: text("subject_type").notNull(),
  subjectId: text("subject_id").notNull(),
  clock: text("clock").notNull(),
  stage: text("stage").notNull(),
  effectiveDeadline: time("effective_deadline").notNull(),
  createdAt: time("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("notification_reminders_deadline_uidx").on(table.subjectType, table.subjectId, table.clock, table.stage, table.effectiveDeadline),
  check("notification_reminders_clock_check", sql`${table.clock} in (${enumValues(NOTIFICATION_CLOCKS)})`),
  check("notification_reminders_stage_check", sql`${table.stage} in ('due_24h','missed')`),
]);
