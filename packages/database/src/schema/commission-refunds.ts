import { sql, type SQLWrapper } from "drizzle-orm";
import { bigint, check, date, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import type { EncryptionEnvelope } from "@pawket/security";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Drizzle Kit requires extensionless schema imports.
// @ts-ignore Drizzle Kit resolves this TypeScript schema without the emitted suffix.
import { commissionOrders } from "./commissions";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Drizzle Kit requires extensionless schema imports.
// @ts-ignore Drizzle Kit resolves this TypeScript schema without the emitted suffix.
import { identityUsers } from "./identity-core";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Drizzle Kit requires extensionless schema imports.
// @ts-ignore Drizzle Kit resolves this TypeScript schema without the emitted suffix.
import { paymentIntents } from "./tips";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Drizzle Kit requires extensionless schema imports.
// @ts-ignore Drizzle Kit resolves this TypeScript schema without the emitted suffix.
import { systemBusinessCalendarVersions } from "./shared-controls";

const time = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const reference = { onDelete: "restrict", onUpdate: "restrict" } as const;
const identifier = (column: SQLWrapper) => sql`${column} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'`;
// Shape checks are not a substitute for authenticated decryption with record binding.
const envelopeCheck = (column: SQLWrapper) => sql`coalesce(
  jsonb_typeof(${column}) = 'object' and octet_length(${column}::text) <= 24000
  and ${column}->'version' = '1'::jsonb and ${column}->>'algorithm' = 'A256GCM'
  and jsonb_typeof(${column}->'keyId') = 'string' and ${column}->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and jsonb_typeof(${column}->'nonce') = 'string' and ${column}->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and jsonb_typeof(${column}->'ciphertext') = 'string' and ${column}->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and jsonb_typeof(${column}->'authenticationTag') = 'string' and ${column}->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and ${column} - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false)`;

export const commissionRefundObligations = pgTable("commission_refund_obligations", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id").notNull().references(() => commissionOrders.id, reference),
  paymentIntentId: uuid("payment_intent_id").notNull().references(() => paymentIntents.id, reference),
  creatorUserId: text("creator_user_id").notNull().references(() => identityUsers.id, reference),
  buyerUserId: text("buyer_user_id").notNull().references(() => identityUsers.id, reference),
  source: text("source").notNull(), sourceId: uuid("source_id").notNull(),
  amountVnd: bigint("amount_vnd", { mode: "number" }).notNull(),
  reference: text("reference").notNull(), state: text("state").notNull().default("awaiting_destination"),
  destinationBankBin: text("destination_bank_bin"), destinationBankName: text("destination_bank_name"),
  destinationAccountEnvelope: jsonb("destination_account_envelope").$type<EncryptionEnvelope<"commission_refund_obligation", "account_number">>(),
  destinationHolderEnvelope: jsonb("destination_holder_envelope").$type<EncryptionEnvelope<"commission_refund_obligation", "holder_name">>(),
  destinationSuffix: text("destination_suffix"), destinationEnteredAt: time("destination_entered_at"),
  destinationPurgedAt: time("destination_purged_at"), dueAt: time("due_at"),
  calendarVersion: text("calendar_version").notNull().references(() => systemBusinessCalendarVersions.version, reference),
  currentSendId: uuid("current_send_id"), confirmBy: time("confirm_by"), endedAt: time("ended_at"),
  version: integer("version").notNull().default(1),
  createdAt: time("created_at").notNull(), updatedAt: time("updated_at").notNull(),
}, (table) => [
  uniqueIndex("commission_refund_obligations_source_uidx").on(table.source, table.sourceId),
  uniqueIndex("commission_refund_obligations_reference_uidx").on(table.reference),
  index("commission_refund_obligations_creator_deadline_idx").on(table.creatorUserId, table.state, table.dueAt),
  index("commission_refund_obligations_confirmation_idx").on(table.state, table.confirmBy),
  index("commission_refund_obligations_order_idx").on(table.orderId, table.createdAt),
  foreignKey({ name: "commission_refund_obligations_current_send_fk", columns: [table.currentSendId, table.id],
    foreignColumns: [commissionRefundSends.id, commissionRefundSends.obligationId] }).onDelete("restrict").onUpdate("restrict"),
  check("commission_refund_obligations_source_check", sql`${table.source} in ('agreement','ruling','correction','late_payment','late_payment_provider','suspension_cancel','fulfillment_freeze')`),
  check("commission_refund_obligations_amount_check", sql`${table.amountVnd} between 1 and 50000000`),
  check("commission_refund_obligations_reference_check", sql`${table.reference} ~ '^PKR[0-9A-HJKMNP-TV-Z]{12}$'`),
  check("commission_refund_obligations_version_check", sql`${table.version} > 0`),
  check("commission_refund_obligations_time_check", sql`${table.updatedAt} >= ${table.createdAt}
    and (${table.destinationEnteredAt} is null or ${table.destinationEnteredAt} >= ${table.createdAt})
    and (${table.dueAt} is null or (${table.destinationEnteredAt} is not null and ${table.dueAt} > ${table.destinationEnteredAt}))
    and (${table.endedAt} is null or ${table.endedAt} >= ${table.createdAt})`),
  check("commission_refund_obligations_destination_check", sql`coalesce(
    (${table.destinationEnteredAt} is null and ${table.destinationBankBin} is null and ${table.destinationBankName} is null
      and ${table.destinationAccountEnvelope} is null and ${table.destinationHolderEnvelope} is null and ${table.destinationSuffix} is null and ${table.destinationPurgedAt} is null)
    or (${table.destinationEnteredAt} is not null and ${table.destinationBankBin} is not null and ${table.destinationBankBin} ~ '^[0-9]{6}$'
      and ${table.destinationBankName} is not null and char_length(btrim(${table.destinationBankName})) between 1 and 100
      and ${table.destinationSuffix} is not null and ${table.destinationSuffix} ~ '^[0-9]{4}$'
      and ((${table.destinationPurgedAt} is null and ${envelopeCheck(table.destinationAccountEnvelope)} and ${envelopeCheck(table.destinationHolderEnvelope)})
        or (${table.destinationPurgedAt} is not null and ${table.state} in ('received','presumed_received','waived') and ${table.endedAt} is not null
          and ${table.destinationPurgedAt} >= ${table.endedAt} + interval '30 days'
          and ${table.destinationAccountEnvelope} is null and ${table.destinationHolderEnvelope} is null))), false)`),
  check("commission_refund_obligations_state_check", sql`(${table.state} = 'awaiting_destination' and ${table.destinationEnteredAt} is null
      and ${table.dueAt} is null and ${table.currentSendId} is null and ${table.confirmBy} is null and ${table.endedAt} is null)
    or (${table.state} = 'awaiting_send' and ${table.destinationEnteredAt} is not null and ${table.dueAt} is not null
      and ${table.currentSendId} is null and ${table.confirmBy} is null and ${table.endedAt} is null)
    or (${table.state} in ('sent','not_received') and ${table.destinationEnteredAt} is not null and ${table.dueAt} is not null
      and ${table.currentSendId} is not null and ${table.confirmBy} is not null and ${table.endedAt} is null)
    or (${table.state} in ('received','presumed_received') and ${table.destinationEnteredAt} is not null and ${table.dueAt} is not null
      and ${table.currentSendId} is not null and ${table.confirmBy} is not null and ${table.endedAt} is not null)
    or (${table.state} = 'waived' and ${table.endedAt} is not null)`),
]);

export const commissionRefundSends = pgTable("commission_refund_sends", {
  id: uuid("id").primaryKey().defaultRandom(),
  obligationId: uuid("obligation_id").notNull().references((): AnyPgColumn => commissionRefundObligations.id, reference),
  transferDate: date("transfer_date").notNull(),
  referenceEnvelope: jsonb("reference_envelope").$type<EncryptionEnvelope<"commission_refund_send", "bank_reference">>().notNull(),
  noteEnvelope: jsonb("note_envelope").$type<EncryptionEnvelope<"commission_refund_send", "note">>(),
  actorUserId: text("actor_user_id").notNull().references(() => identityUsers.id, reference),
  actorSessionId: text("actor_session_id").notNull(), requestId: text("request_id").notNull(), recordedAt: time("recorded_at").notNull(),
}, (table) => [
  uniqueIndex("commission_refund_sends_binding_uidx").on(table.id, table.obligationId),
  uniqueIndex("commission_refund_sends_request_uidx").on(table.obligationId, table.requestId),
  index("commission_refund_sends_timeline_idx").on(table.obligationId, table.recordedAt),
  check("commission_refund_sends_envelopes_check", sql`${envelopeCheck(table.referenceEnvelope)} and (${table.noteEnvelope} is null or ${envelopeCheck(table.noteEnvelope)})`),
  check("commission_refund_sends_actor_check", identifier(table.actorSessionId)),
  check("commission_refund_sends_request_check", identifier(table.requestId)),
]);

export const commissionRefundEvents = pgTable("commission_refund_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  obligationId: uuid("obligation_id").notNull().references(() => commissionRefundObligations.id, reference),
  action: text("action").notNull(), actorUserId: text("actor_user_id").references(() => identityUsers.id, reference),
  actorSessionId: text("actor_session_id"), fromState: text("from_state"), toState: text("to_state").notNull(),
  requestId: text("request_id").notNull(), occurredAt: time("occurred_at").notNull(),
}, (table) => [
  index("commission_refund_events_timeline_idx").on(table.obligationId, table.occurredAt, table.id),
  uniqueIndex("commission_refund_events_request_action_uidx").on(table.obligationId, table.requestId, table.action),
  check("commission_refund_events_action_check", sql`${table.action} in ('created','destination_entered','destination_revealed','sent_recorded','receipt_confirmed','receipt_denied','presumed_received','resend_required','deadline_extended','amount_adjusted','waived','destination_purged')`),
  check("commission_refund_events_state_check", sql`(${table.fromState} is null or ${table.fromState} in ('awaiting_destination','awaiting_send','sent','received','presumed_received','not_received','waived'))
    and ${table.toState} in ('awaiting_destination','awaiting_send','sent','received','presumed_received','not_received','waived')`),
  check("commission_refund_events_actor_check", sql`(${table.actorUserId} is null and ${table.actorSessionId} is null)
    or (${table.actorUserId} is not null and ${table.actorSessionId} is not null and ${identifier(table.actorSessionId)})`),
  check("commission_refund_events_request_check", identifier(table.requestId)),
]);
