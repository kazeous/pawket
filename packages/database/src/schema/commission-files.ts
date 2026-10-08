import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { EncryptionEnvelope } from "@pawket/security";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Drizzle Kit requires extensionless schema imports.
// @ts-ignore Drizzle Kit resolves this TypeScript schema without the emitted suffix.
import { identityUsers } from "./identity-core";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Drizzle Kit requires extensionless schema imports.
// @ts-ignore Drizzle Kit resolves this TypeScript schema without the emitted suffix.
import { commissionEnvelopeCheck, commissionOrders, commissionPackages } from "./commissions";

const time = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
export const COMMISSION_FILE_CONTEXTS_DB = ["brief", "thread", "submission", "resolution_evidence"] as const;
export const COMMISSION_FILE_STATES = ["awaiting_upload", "scanning", "clean", "attached", "rejected", "scan_failed", "expired", "discarded", "deleted"] as const;
export type CommissionFileState = typeof COMMISSION_FILE_STATES[number];
const states = COMMISSION_FILE_STATES.map((state) => `'${state}'`).join(",");

export const commissionFiles = pgTable("commission_files", {
  id: uuid("id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull().references(() => identityUsers.id, { onDelete: "restrict" }),
  context: text("context").notNull(),
  packageId: uuid("package_id").references(() => commissionPackages.id, { onDelete: "restrict" }),
  uploadOrderId: uuid("upload_order_id").references(() => commissionOrders.id, { onDelete: "restrict" }),
  orderId: uuid("order_id").references(() => commissionOrders.id, { onDelete: "restrict" }),
  state: text("state").notNull().default("awaiting_upload"),
  version: integer("version").notNull().default(1),
  declaredBytes: bigint("declared_bytes", { mode: "number" }).notNull(),
  filenameEnvelope: jsonb("filename_envelope").$type<EncryptionEnvelope<"commission_files", "filename">>(),
  cleanCopyIntent: boolean("clean_copy_intent").notNull().default(false),
  objectKey: text("object_key").notNull(),
  quarantineVersionId: text("quarantine_version_id"),
  cleanVersionId: text("clean_version_id"),
  detectedType: text("detected_type"),
  sha256: text("sha256"),
  rejectionReason: text("rejection_reason"),
  malwareSignature: text("malware_signature"),
  scanAttempts: integer("scan_attempts").notNull().default(0),
  nextScanAt: time("next_scan_at"),
  scanLeaseExpiresAt: time("scan_lease_expires_at"),
  uploadExpiresAt: time("upload_expires_at").notNull(),
  uploadedAt: time("uploaded_at"),
  scanDeadlineAt: time("scan_deadline_at"),
  cleanAt: time("clean_at"),
  attachedAt: time("attached_at"),
  endedAt: time("ended_at"),
  quarantinePurgedAt: time("quarantine_purged_at"),
  cleanPurgedAt: time("clean_purged_at"),
  requestId: text("request_id").notNull(),
  createdAt: time("created_at").notNull(),
  updatedAt: time("updated_at").notNull(),
}, (t) => [
  index("commission_files_owner_state_idx").on(t.ownerUserId, t.state, t.createdAt),
  index("commission_files_order_idx").on(t.orderId, t.state),
  index("commission_files_upload_order_idx").on(t.uploadOrderId, t.state).where(sql`${t.uploadOrderId} is not null`),
  index("commission_files_scan_due_idx").on(t.nextScanAt, t.id).where(sql`${t.state} = 'scanning'`),
  index("commission_files_upload_expiry_idx").on(t.uploadExpiresAt, t.id).where(sql`${t.state} = 'awaiting_upload'`),
  index("commission_files_unsent_idx").on(t.cleanAt, t.id).where(sql`${t.state} = 'clean'`),
  index("commission_files_purge_idx").on(t.updatedAt, t.id).where(sql`${t.state} in ('rejected','scan_failed','expired','discarded','deleted','clean','attached') and (${t.quarantinePurgedAt} is null or (${t.cleanPurgedAt} is null and ${t.state} in ('rejected','scan_failed','expired','discarded','deleted')))`),
  check("commission_files_context_check", sql`(${t.context} = 'brief' and ${t.packageId} is not null and ${t.uploadOrderId} is null)
    or (${t.context} in ('thread','submission','resolution_evidence') and ${t.packageId} is null and ${t.uploadOrderId} is not null)`),
  check("commission_files_state_check", sql`${t.state} in (${sql.raw(states)}) and ${t.version} > 0 and ${t.scanAttempts} between 0 and 1000`),
  check("commission_files_order_check", sql`(${t.state} in ('attached','deleted')) = (${t.orderId} is not null and ${t.attachedAt} is not null)`),
  check("commission_files_size_check", sql`${t.declaredBytes} between 1 and case when ${t.context} = 'submission' then 262144000 else 26214400 end`),
  check("commission_files_key_check", sql`${t.objectKey} = 'commission/' || ${t.id}::text`),
  check("commission_files_filename_check", sql`case when ${t.orderId} is null and ${t.state} in ('rejected','scan_failed','expired','discarded') then ${t.filenameEnvelope} is null else ${commissionEnvelopeCheck(t.filenameEnvelope)} end`),
  check("commission_files_type_check", sql`${t.detectedType} is null or ${t.detectedType} in ('jpeg','png','webp','pdf')
    or (${t.context} <> 'resolution_evidence' and ${t.detectedType} = 'gif')
    or (${t.context} = 'submission' and ${t.detectedType} in ('psd','clip','zip'))`),
  check("commission_files_digest_check", sql`${t.sha256} is null or ${t.sha256} ~ '^sha256:[a-f0-9]{64}$'`),
  check("commission_files_clean_evidence_check", sql`(${t.state} not in ('clean','attached','deleted') or (${t.sha256} is not null and ${t.detectedType} is not null and ${t.cleanVersionId} is not null and ${t.cleanAt} is not null))
    and (${t.state} not in ('awaiting_upload','scanning') or (${t.sha256} is null and ${t.detectedType} is null and ${t.cleanVersionId} is null and ${t.cleanAt} is null))`),
  check("commission_files_rejection_check", sql`(${t.state} = 'rejected') = (${t.rejectionReason} is not null)
    and (${t.rejectionReason} is null or ${t.rejectionReason} in ('malware','type_not_allowed','size_mismatch','encrypted_archive','limits_exceeded'))
    and coalesce(${t.rejectionReason} = 'malware', false) = (${t.malwareSignature} is not null)
    and (${t.malwareSignature} is null or ${t.malwareSignature} ~ '^[A-Za-z0-9._:-]{1,200}$')`),
  check("commission_files_upload_time_check", sql`(${t.state} not in ('awaiting_upload','expired') or ${t.uploadedAt} is null)
    and (${t.state} not in ('scanning','clean','attached','rejected','scan_failed','deleted') or ${t.uploadedAt} is not null)
    and (${t.uploadedAt} is null) = (${t.scanDeadlineAt} is null)
    and (${t.uploadedAt} is null or (${t.uploadedAt} >= ${t.createdAt} and ${t.scanDeadlineAt} = ${t.uploadedAt} + interval '24 hours'))
    and ${t.uploadExpiresAt} = ${t.createdAt} + interval '15 minutes'`),
  check("commission_files_end_check", sql`(${t.state} in ('rejected','scan_failed','expired','discarded','deleted')) = (${t.endedAt} is not null)`),
  check("commission_files_lease_check", sql`(${t.scanLeaseExpiresAt} is null or ${t.state} = 'scanning') and (${t.nextScanAt} is null or ${t.state} = 'scanning')`),
  check("commission_files_time_check", sql`${t.updatedAt} >= ${t.createdAt} and char_length(${t.requestId}) between 1 and 200`),
]);

export const commissionFileAttachments = pgTable("commission_file_attachments", {
  fileId: uuid("file_id").primaryKey().references(() => commissionFiles.id, { onDelete: "restrict" }),
  orderId: uuid("order_id").notNull().references(() => commissionOrders.id, { onDelete: "restrict" }),
  targetKind: text("target_kind").notNull(),
  targetId: uuid("target_id").notNull(),
  position: integer("position").notNull(),
  attachedAt: time("attached_at").notNull(),
}, (t) => [
  uniqueIndex("commission_file_attachment_position_uidx").on(t.targetKind, t.targetId, t.position),
  index("commission_file_attachment_order_idx").on(t.orderId, t.targetKind, t.targetId),
  check("commission_file_attachment_target_check", sql`(${t.targetKind} = 'brief' and ${t.targetId} = ${t.orderId} and ${t.position} between 0 and 9)
    or (${t.targetKind} = 'message' and ${t.position} between 0 and 9) or (${t.targetKind} = 'submission' and ${t.position} between 0 and 19)
    or (${t.targetKind} in ('refund_send','late_claim') and ${t.position} between 0 and 2)`),
]);

export const commissionThreads = pgTable("commission_threads", {
  orderId: uuid("order_id").primaryKey().references(() => commissionOrders.id, { onDelete: "restrict" }),
  nextSequence: integer("next_sequence").notNull().default(1),
  createdAt: time("created_at").notNull(),
  updatedAt: time("updated_at").notNull(),
}, (t) => [
  check("commission_threads_sequence_check", sql`${t.nextSequence} > 0`),
]);

export const commissionThreadEntries = pgTable("commission_thread_entries", {
  orderId: uuid("order_id").notNull().references(() => commissionThreads.orderId, { onDelete: "restrict" }),
  sequence: integer("sequence").notNull(),
  kind: text("kind").notNull(),
  entryId: uuid("entry_id").notNull(),
  createdAt: time("created_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.orderId, t.sequence] }),
  uniqueIndex("commission_thread_entries_entry_uidx").on(t.kind, t.entryId),
  index("commission_thread_entries_order_idx").on(t.orderId, t.sequence.desc()),
  check("commission_thread_entries_check", sql`${t.kind} in ('message','submission') and ${t.sequence} > 0`),
]);

export const commissionMessages = pgTable("commission_messages", {
  id: uuid("id").primaryKey(),
  orderId: uuid("order_id").notNull().references(() => commissionOrders.id, { onDelete: "restrict" }),
  authorUserId: text("author_user_id").notNull().references(() => identityUsers.id, { onDelete: "restrict" }),
  authorSessionId: text("author_session_id").notNull(),
  textEnvelope: jsonb("text_envelope").$type<EncryptionEnvelope<"commission_messages", "text">>(),
  requestId: text("request_id").notNull(),
  createdAt: time("created_at").notNull(),
}, (t) => [
  check("commission_messages_text_check", sql`${t.textEnvelope} is null or ${commissionEnvelopeCheck(t.textEnvelope)}`),
]);
