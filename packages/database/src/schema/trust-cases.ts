import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Drizzle Kit requires extensionless schema imports.
// @ts-ignore Drizzle Kit resolves this TypeScript schema without the emitted suffix.
import { commissionOrders, commissionPolicyRevisions } from "./commissions";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Drizzle Kit requires extensionless schema imports.
// @ts-ignore Drizzle Kit resolves this TypeScript schema without the emitted suffix.
import { identityUsers } from "./identity-core";

export const TRUST_CASE_KINDS = ["dispute", "refund_not_received", "refund_overdue", "late_payment"] as const;
const time = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const reference = { onDelete: "restrict", onUpdate: "restrict" } as const;

export const trustCases = pgTable("trust_cases", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull(),
  orderId: uuid("order_id").notNull().references(() => commissionOrders.id, reference),
  sourceType: text("source_type").notNull(),
  sourceId: uuid("source_id").notNull(),
  state: text("state").notNull().default("open"),
  resolutionKind: text("resolution_kind"),
  policyRevisionId: uuid("policy_revision_id").references(() => commissionPolicyRevisions.id, reference),
  openedAt: time("opened_at").notNull(),
  resolvedAt: time("resolved_at"),
  version: integer("version").notNull().default(1),
}, (table) => [
  uniqueIndex("trust_cases_open_source_uidx").on(table.kind, table.sourceId).where(sql`${table.state} = 'open'`),
  index("trust_cases_queue_idx").on(table.state, table.openedAt, table.id),
  index("trust_cases_order_hold_idx").on(table.orderId, table.state, table.resolvedAt),
  check("trust_cases_source_check", sql`(${table.kind} = 'dispute' and ${table.sourceType} = 'commission_dispute')
    or (${table.kind} in ('refund_not_received','refund_overdue') and ${table.sourceType} = 'commission_refund_obligation')
    or (${table.kind} = 'late_payment' and ${table.sourceType} = 'commission_late_payment_claim')`),
  check("trust_cases_resolution_check", sql`(${table.state} = 'open' and ${table.resolutionKind} is null and ${table.resolvedAt} is null)
    or (${table.state} = 'resolved' and ${table.resolvedAt} is not null and ${table.resolvedAt} >= ${table.openedAt}
      and ${table.resolutionKind} is not null and (
        (${table.kind} = 'dispute' and ${table.resolutionKind} in ('ruled','settled','withdrawn','superseded'))
        or (${table.kind} = 'refund_not_received' and ${table.resolutionKind} in ('receipt_accepted','resend_required','waived'))
        or (${table.kind} = 'refund_overdue' and ${table.resolutionKind} in ('send_recorded','extended','waived'))
        or (${table.kind} = 'late_payment' and ${table.resolutionKind} in ('refund_owed','rejected'))))`),
  check("trust_cases_version_check", sql`${table.version} > 0`),
]);

export const trustCaseEvents = pgTable("trust_case_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  caseId: uuid("case_id").notNull().references(() => trustCases.id, reference),
  action: text("action").notNull(),
  actorUserId: text("actor_user_id").references(() => identityUsers.id, reference),
  actorSessionId: text("actor_session_id"),
  reason: text("reason"),
  requestId: text("request_id").notNull(),
  expectedVersion: integer("expected_version").notNull(),
  resultingVersion: integer("resulting_version").notNull(),
  beforeState: text("before_state"),
  afterState: text("after_state").notNull(),
  resolutionKind: text("resolution_kind"),
  occurredAt: time("occurred_at").notNull(),
}, (table) => [
  uniqueIndex("trust_case_events_version_uidx").on(table.caseId, table.resultingVersion),
  index("trust_case_events_timeline_idx").on(table.caseId, table.occurredAt, table.id),
  check("trust_case_events_version_check", sql`${table.expectedVersion} >= 0 and ${table.resultingVersion} = ${table.expectedVersion} + 1`),
  check("trust_case_events_transition_check", sql`(${table.action} = 'opened' and ${table.expectedVersion} = 0 and ${table.beforeState} is null and ${table.afterState} = 'open' and ${table.resolutionKind} is null)
    or (${table.action} in ('question_posted','deadline_extended') and ${table.expectedVersion} > 0 and ${table.beforeState} is not null and ${table.beforeState} = 'open' and ${table.afterState} = 'open' and ${table.resolutionKind} is null)
    or (${table.action} = 'resolved' and ${table.expectedVersion} > 0 and ${table.beforeState} is not null and ${table.beforeState} = 'open' and ${table.afterState} = 'resolved' and ${table.resolutionKind} is not null)`),
  check("trust_case_events_actor_check", sql`(${table.actorUserId} is null and ${table.actorSessionId} is null)
    or (${table.actorUserId} is not null and ${table.actorSessionId} is not null and ${table.actorSessionId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$')`),
  check("trust_case_events_request_check", sql`${table.requestId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'`),
  check("trust_case_events_reason_check", sql`${table.reason} is null or (char_length(${table.reason}) between 1 and 2000 and normalize(${table.reason}) = ${table.reason} and ${table.reason} !~ '[[:cntrl:]]')`),
]);

export const trustCaseAccessLog = pgTable("trust_case_access_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  caseId: uuid("case_id").notNull().references(() => trustCases.id, reference),
  itemType: text("item_type").notNull(),
  itemId: uuid("item_id").notNull(),
  ownerUserId: text("owner_user_id").notNull().references(() => identityUsers.id, reference),
  ownerSessionId: text("owner_session_id").notNull(),
  requestId: text("request_id").notNull(),
  accessedAt: time("accessed_at").notNull(),
}, (table) => [
  index("trust_case_access_log_case_idx").on(table.caseId, table.accessedAt, table.id),
  check("trust_case_access_log_item_check", sql`${table.itemType} in ('order_summary','thread_page','file','resolution_records','refund_destination')`),
  check("trust_case_access_log_actor_check", sql`${table.ownerSessionId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' and ${table.requestId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'`),
]);
