import { sql, type SQLWrapper } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import type { EncryptionEnvelope } from "@pawket/security";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Drizzle Kit requires extensionless schema imports.
// @ts-ignore Drizzle Kit 0.31 resolves this TypeScript schema without the emitted suffix.
import { identityUsers } from "./identity-core";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Drizzle Kit requires extensionless schema imports.
// @ts-ignore Drizzle Kit 0.31 resolves this TypeScript schema without the emitted suffix.
import { paymentsReceivingAccountOnboarding } from "./payments";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Drizzle Kit requires extensionless schema imports.
// @ts-ignore Drizzle Kit resolves this TypeScript schema without the emitted suffix.
import { platformTipPolicyRevisions } from "./platform-tip-policy";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Drizzle Kit requires extensionless schema imports.
// @ts-ignore Drizzle Kit resolves this TypeScript schema without the emitted suffix.
import { paymentsSepayAccountCutovers, paymentsSepayTransactions } from "./sepay";

const time = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const vnd = (name: string) => bigint(name, { mode: "number" });
const hmacCheck = (column: SQLWrapper) => sql`${column} ~ '^hmac-sha256:v1:[A-Za-z0-9_-]{43}$'`;
// Shape checks are not a substitute for authenticated decryption with AAD.
const envelopeCheck = (column: SQLWrapper) => sql`coalesce(
  jsonb_typeof(${column}) = 'object' and octet_length(${column}::text) <= 24000
  and ${column}->'version' = '1'::jsonb and ${column}->>'algorithm' = 'A256GCM'
  and jsonb_typeof(${column}->'keyId') = 'string' and ${column}->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and jsonb_typeof(${column}->'nonce') = 'string' and ${column}->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and jsonb_typeof(${column}->'ciphertext') = 'string' and ${column}->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and jsonb_typeof(${column}->'authenticationTag') = 'string' and ${column}->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and ${column} - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb,
  false)`;

export const creatorTipSettingRevisions = pgTable("creator_tip_setting_revisions", {
  id: uuid("id").primaryKey(),
  platformPolicyRevisionId: uuid("platform_policy_revision_id").references(() => platformTipPolicyRevisions.id, { onDelete: "restrict", onUpdate: "restrict" }),
  creatorUserId: text("creator_user_id").notNull().references(() => identityUsers.id, { onDelete: "restrict", onUpdate: "restrict" }),
  revisionNumber: integer("revision_number").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  minimumVnd: vnd("minimum_vnd").notNull(),
  maximumVnd: vnd("maximum_vnd").notNull(),
  presetsVnd: integer("presets_vnd").array().notNull(),
  actorSessionId: text("actor_session_id").notNull(),
  requestId: text("request_id").notNull(),
  createdAt: time("created_at").notNull(),
}, (table) => [
  uniqueIndex("creator_tip_revisions_number_uidx").on(table.creatorUserId, table.revisionNumber),
  uniqueIndex("creator_tip_revisions_binding_uidx").on(table.id, table.creatorUserId),
  check("creator_tip_revisions_number_check", sql`${table.revisionNumber} > 0`),
  check("creator_tip_revisions_bounds_check", sql`${table.minimumVnd} >= 10000 and ${table.maximumVnd} <= 5000000 and ${table.maximumVnd} >= ${table.minimumVnd}`),
  check("creator_tip_revisions_presets_check", sql`coalesce(array_ndims(${table.presetsVnd}) = 1 and array_lower(${table.presetsVnd}, 1) = 1 and cardinality(${table.presetsVnd}) = 3
    and array_position(${table.presetsVnd}, null) is null
    and ${table.presetsVnd}[1] between ${table.minimumVnd} and ${table.maximumVnd}
    and ${table.presetsVnd}[2] between ${table.minimumVnd} and ${table.maximumVnd}
    and ${table.presetsVnd}[3] between ${table.minimumVnd} and ${table.maximumVnd}
    and ${table.presetsVnd}[1] <> ${table.presetsVnd}[2] and ${table.presetsVnd}[1] <> ${table.presetsVnd}[3] and ${table.presetsVnd}[2] <> ${table.presetsVnd}[3], false)`),
]);

export const creatorTipSettings = pgTable("creator_tip_settings", {
  creatorUserId: text("creator_user_id").primaryKey().references(() => identityUsers.id, { onDelete: "restrict", onUpdate: "restrict" }),
  revisionId: uuid("revision_id").notNull(),
  createdAt: time("created_at").notNull(),
  updatedAt: time("updated_at").notNull(),
}, (table) => [
  foreignKey({ name: "creator_tip_settings_revision_owner_fk", columns: [table.revisionId, table.creatorUserId], foreignColumns: [creatorTipSettingRevisions.id, creatorTipSettingRevisions.creatorUserId] }).onDelete("restrict").onUpdate("restrict"),
  check("creator_tip_settings_time_check", sql`${table.updatedAt} >= ${table.createdAt}`),
]);

export const tips = pgTable("tips", {
  id: uuid("id").primaryKey(),
  platformPolicyRevisionId: uuid("platform_policy_revision_id").references(() => platformTipPolicyRevisions.id, { onDelete: "restrict", onUpdate: "restrict" }),
  creatorUserId: text("creator_user_id").notNull().references(() => identityUsers.id, { onDelete: "restrict", onUpdate: "restrict" }),
  buyerUserId: text("buyer_user_id").references(() => identityUsers.id, { onDelete: "restrict", onUpdate: "restrict" }),
  settingRevisionId: uuid("setting_revision_id").notNull(),
  amountVnd: vnd("amount_vnd").notNull(),
  guestContentEnvelope: jsonb("guest_content_envelope").$type<EncryptionEnvelope<"tips", "guest_content">>().notNull(),
  state: text("state").notNull().default("awaiting_payment"),
  closedAt: time("closed_at"),
  createdAt: time("created_at").notNull(),
  updatedAt: time("updated_at").notNull(),
}, (table) => [
  uniqueIndex("tips_payment_binding_uidx").on(table.id, table.creatorUserId, table.amountVnd),
  index("tips_buyer_created_idx").on(table.buyerUserId, table.createdAt).where(sql`${table.buyerUserId} is not null`),
  foreignKey({ name: "tips_setting_owner_fk", columns: [table.settingRevisionId, table.creatorUserId], foreignColumns: [creatorTipSettingRevisions.id, creatorTipSettingRevisions.creatorUserId] }).onDelete("restrict").onUpdate("restrict"),
  check("tips_amount_check", sql`${table.amountVnd} between 1 and 9007199254740991`),
  check("tips_content_envelope_check", envelopeCheck(table.guestContentEnvelope)),
  check("tips_state_check", sql`${table.state} in ('awaiting_payment','completed','expired','rejected')`),
  check("tips_time_check", sql`${table.updatedAt} >= ${table.createdAt} and (
    (${table.state} = 'awaiting_payment' and ${table.closedAt} is null) or
    (${table.state} <> 'awaiting_payment' and ${table.closedAt} is not null and ${table.closedAt} >= ${table.createdAt} and ${table.updatedAt} = ${table.closedAt}))`),
]);

export const paymentIntents = pgTable("payment_intents", {
  id: uuid("id").primaryKey(),
  purpose: text("purpose").notNull().default("tip"),
  tipId: uuid("tip_id").notNull(),
  creatorUserId: text("creator_user_id").notNull(),
  amountVnd: vnd("amount_vnd").notNull(),
  currency: text("currency").notNull().default("VND"),
  referenceHash: text("reference_hash").notNull(),
  referenceEnvelope: jsonb("reference_envelope").$type<EncryptionEnvelope<"payment_intents", "transfer_reference">>().notNull(),
  destinationEnvelope: jsonb("destination_envelope").$type<EncryptionEnvelope<"payment_intents", "destination">>().notNull(),
  accountVersionId: uuid("account_version_id").notNull().references(() => paymentsReceivingAccountOnboarding.id, { onDelete: "restrict", onUpdate: "restrict" }),
  settlementLane: text("settlement_lane").notNull().default("manual_attested"),
  cutoverId: uuid("cutover_id").references((): AnyPgColumn => paymentsSepayAccountCutovers.id, { onDelete: "restrict", onUpdate: "restrict" }),
  abuseKeyHash: text("abuse_key_hash").notNull(),
  state: text("state").notNull().default("awaiting_transfer"),
  expiresAt: time("expires_at").notNull(),
  closedAt: time("closed_at"),
  rejectionReason: text("rejection_reason"),
  requestId: text("request_id").notNull(),
  createdAt: time("created_at").notNull(),
  updatedAt: time("updated_at").notNull(),
}, (table) => [
  uniqueIndex("payment_intents_tip_uidx").on(table.tipId),
  uniqueIndex("payment_intents_reference_uidx").on(table.referenceHash),
  uniqueIndex("payment_intents_confirmation_binding_uidx").on(table.id, table.creatorUserId, table.amountVnd, table.referenceHash, table.accountVersionId),
  index("payment_intents_creator_queue_idx").on(table.creatorUserId, table.state, table.createdAt, table.id),
  index("payment_intents_expiry_idx").on(table.expiresAt, table.id).where(sql`${table.state} = 'awaiting_transfer'`),
  index("payment_intents_open_abuse_idx").on(table.abuseKeyHash, table.createdAt).where(sql`${table.state} = 'awaiting_transfer'`),
  foreignKey({ name: "payment_intents_tip_binding_fk", columns: [table.tipId, table.creatorUserId, table.amountVnd], foreignColumns: [tips.id, tips.creatorUserId, tips.amountVnd] }).onDelete("restrict").onUpdate("restrict"),
  check("payment_intents_purpose_check", sql`${table.purpose} = 'tip' and ${table.currency} = 'VND'`),
  check("payment_intents_settlement_lane_check", sql`(${table.settlementLane} = 'manual_attested' and ${table.cutoverId} is null)
    or (${table.settlementLane} = 'provider_bound' and ${table.cutoverId} is not null)`),
  check("payment_intents_amount_check", sql`${table.amountVnd} between 1 and 9999999999999`),
  check("payment_intents_reference_hash_check", hmacCheck(table.referenceHash)),
  check("payment_intents_abuse_hash_check", hmacCheck(table.abuseKeyHash)),
  check("payment_intents_reference_envelope_check", envelopeCheck(table.referenceEnvelope)),
  check("payment_intents_destination_envelope_check", envelopeCheck(table.destinationEnvelope)),
  check("payment_intents_state_check", sql`${table.state} in ('awaiting_transfer','confirmed','expired','rejected')`),
  check("payment_intents_time_check", sql`${table.expiresAt} > ${table.createdAt} and ${table.updatedAt} >= ${table.createdAt} and (
    (${table.state} = 'awaiting_transfer' and ${table.closedAt} is null) or
    (${table.state} <> 'awaiting_transfer' and ${table.closedAt} is not null and ${table.closedAt} >= ${table.createdAt} and ${table.updatedAt} = ${table.closedAt}))
    and (${table.state} <> 'confirmed' or ${table.closedAt} < ${table.expiresAt})
    and (${table.state} <> 'expired' or ${table.closedAt} >= ${table.expiresAt})`),
  check("payment_intents_rejection_check", sql`(${table.state} = 'rejected' and ${table.rejectionReason} is not null and ${table.rejectionReason} in ('policy_invalidated','security_invalidated'))
    or (${table.state} <> 'rejected' and ${table.rejectionReason} is null)`),
]);

export const paymentGuestCapabilities = pgTable("payment_guest_capabilities", {
  id: uuid("id").primaryKey(),
  paymentIntentId: uuid("payment_intent_id").notNull().references(() => paymentIntents.id, { onDelete: "restrict", onUpdate: "restrict" }),
  capabilityHash: text("capability_hash").notNull(),
  createdAt: time("created_at").notNull(),
  expiresAt: time("expires_at").notNull(),
}, (table) => [
  uniqueIndex("payment_guest_capabilities_intent_uidx").on(table.paymentIntentId),
  uniqueIndex("payment_guest_capabilities_hash_uidx").on(table.capabilityHash),
  uniqueIndex("payment_guest_capabilities_binding_uidx").on(table.id, table.paymentIntentId),
  index("payment_guest_capabilities_expiry_idx").on(table.expiresAt),
  check("payment_guest_capabilities_hash_check", hmacCheck(table.capabilityHash)),
  check("payment_guest_capabilities_time_check", sql`${table.expiresAt} > ${table.createdAt}`),
]);

export const paymentTransferClaims = pgTable("payment_transfer_claims", {
  id: uuid("id").primaryKey(),
  paymentIntentId: uuid("payment_intent_id").notNull().references(() => paymentIntents.id, { onDelete: "restrict", onUpdate: "restrict" }),
  accessKind: text("access_kind").notNull(),
  buyerUserId: text("buyer_user_id").references(() => identityUsers.id, { onDelete: "restrict", onUpdate: "restrict" }),
  guestCapabilityId: uuid("guest_capability_id"),
  authoritative: boolean("authoritative").notNull().default(false),
  requestId: text("request_id").notNull(),
  claimedAt: time("claimed_at").notNull(),
}, (table) => [
  uniqueIndex("payment_transfer_claims_intent_uidx").on(table.paymentIntentId),
  foreignKey({ name: "payment_transfer_claims_guest_intent_fk", columns: [table.guestCapabilityId, table.paymentIntentId], foreignColumns: [paymentGuestCapabilities.id, paymentGuestCapabilities.paymentIntentId] }).onDelete("restrict").onUpdate("restrict"),
  check("payment_transfer_claims_untrusted_check", sql`${table.authoritative} = false`),
  check("payment_transfer_claims_access_check", sql`(${table.accessKind} = 'guest' and ${table.guestCapabilityId} is not null and ${table.buyerUserId} is null)
    or (${table.accessKind} = 'buyer' and ${table.guestCapabilityId} is null and ${table.buyerUserId} is not null)`),
]);

export const paymentConfirmations = pgTable("payment_confirmations", {
  id: uuid("id").primaryKey(),
  paymentIntentId: uuid("payment_intent_id").notNull(),
  creatorUserId: text("creator_user_id").notNull(),
  accountVersionId: uuid("account_version_id").notNull(),
  observedAmountVnd: vnd("observed_amount_vnd").notNull(),
  referenceHash: text("reference_hash").notNull(),
  bankTransactionFingerprint: text("bank_transaction_fingerprint"),
  providerTransactionId: uuid("provider_transaction_id").references((): AnyPgColumn => paymentsSepayTransactions.id, { onDelete: "restrict", onUpdate: "restrict" }),
  workerIdentity: text("worker_identity"),
  source: text("source").notNull().default("creator_manual"),
  attestedReceived: boolean("attested_received"),
  actorSessionId: text("actor_session_id"),
  primaryAuthenticatedAt: time("primary_authenticated_at"),
  totpVerifiedAt: time("totp_verified_at"),
  idempotencyKeyHash: text("idempotency_key_hash"),
  requestId: text("request_id").notNull(),
  confirmedAt: time("confirmed_at").notNull(),
}, (table) => [
  uniqueIndex("payment_confirmations_intent_uidx").on(table.paymentIntentId),
  uniqueIndex("payment_confirmations_bank_txn_uidx").on(table.bankTransactionFingerprint),
  uniqueIndex("payment_confirmations_provider_txn_uidx").on(table.providerTransactionId),
  foreignKey({ name: "payment_confirmations_intent_binding_fk", columns: [table.paymentIntentId, table.creatorUserId, table.observedAmountVnd, table.referenceHash, table.accountVersionId], foreignColumns: [paymentIntents.id, paymentIntents.creatorUserId, paymentIntents.amountVnd, paymentIntents.referenceHash, paymentIntents.accountVersionId] }).onDelete("restrict").onUpdate("restrict"),
  check("payment_confirmations_source_check", sql`coalesce(
    (${table.source} = 'creator_manual' and ${table.bankTransactionFingerprint} is not null and ${table.providerTransactionId} is null and ${table.workerIdentity} is null
      and ${table.attestedReceived} = true and ${table.actorSessionId} is not null and ${table.primaryAuthenticatedAt} is not null and ${table.idempotencyKeyHash} is not null)
    or (${table.source} = 'sepay_automatic' and ${table.bankTransactionFingerprint} is null and ${table.providerTransactionId} is not null
      and ${table.workerIdentity} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' and ${table.attestedReceived} is null and ${table.actorSessionId} is null
      and ${table.primaryAuthenticatedAt} is null and ${table.totpVerifiedAt} is null and ${table.idempotencyKeyHash} is null)
    or (${table.source} = 'creator_reviewed_sepay' and ${table.bankTransactionFingerprint} is null and ${table.providerTransactionId} is not null and ${table.workerIdentity} is null
      and ${table.attestedReceived} = true and ${table.actorSessionId} is not null and ${table.primaryAuthenticatedAt} is not null and ${table.idempotencyKeyHash} is not null), false)`),
  check("payment_confirmations_bank_txn_check", hmacCheck(table.bankTransactionFingerprint)),
  check("payment_confirmations_idempotency_check", hmacCheck(table.idempotencyKeyHash)),
  check("payment_confirmations_assurance_time_check", sql`${table.primaryAuthenticatedAt} <= ${table.confirmedAt}
    and ${table.primaryAuthenticatedAt} >= ${table.confirmedAt} - interval '15 minutes'
    and (${table.totpVerifiedAt} is null or (${table.totpVerifiedAt} <= ${table.confirmedAt} and ${table.totpVerifiedAt} >= ${table.confirmedAt} - interval '5 minutes'))`),
]);
