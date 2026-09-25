import { sql, type SQLWrapper } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import type { EncryptionEnvelope } from "@pawket/security";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Drizzle Kit resolves schema source without emitted suffixes.
// @ts-ignore Drizzle Kit requires extensionless TypeScript imports.
import { identityUsers } from "./identity-core";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Drizzle Kit resolves schema source without emitted suffixes.
// @ts-ignore Drizzle Kit requires extensionless TypeScript imports.
import { paymentsReceivingAccountOnboarding } from "./payments";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Drizzle Kit resolves schema source without emitted suffixes.
// @ts-ignore Drizzle Kit requires extensionless TypeScript imports.
import { paymentIntents } from "./tips";

const time = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const hmac = (column: SQLWrapper) => sql`${column} ~ '^hmac-sha256:v1:[A-Za-z0-9_-]{43}$'`;
const digest = (column: SQLWrapper) => sql`${column} ~ '^sha256:[a-f0-9]{64}$'`;
const boundedIdentity = (column: SQLWrapper) => sql`char_length(${column}) between 1 and 200 and ${column} !~ '[[:cntrl:]]'`;
const envelope = (column: SQLWrapper) => sql`coalesce(jsonb_typeof(${column}) = 'object' and octet_length(${column}::text) <= 24000
  and ${column}->'version' = '1'::jsonb and ${column}->>'algorithm' = 'A256GCM'
  and ${column}->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and ${column}->>'nonce' ~ '^[A-Za-z0-9_-]{16}$' and ${column}->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and ${column}->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and ${column} - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false)`;

export const paymentsSepayConnections = pgTable("payments_sepay_connections", {
  id: uuid("id").primaryKey(),
  creatorUserId: text("creator_user_id").notNull().references(() => identityUsers.id, { onDelete: "restrict", onUpdate: "restrict" }),
  accountVersionId: uuid("account_version_id").notNull().references(() => paymentsReceivingAccountOnboarding.id, { onDelete: "restrict", onUpdate: "restrict" }),
  accountFingerprint: text("account_fingerprint").notNull(),
  providerEnvironment: text("provider_environment").notNull(),
  providerTenantId: text("provider_tenant_id"),
  providerAccountId: text("provider_account_id"),
  status: text("status").notNull().default("setup_pending"),
  version: integer("version").notNull().default(1),
  currentRevisionId: uuid("current_revision_id").references((): AnyPgColumn => paymentsSepayConnectionRevisions.id, { onDelete: "restrict", onUpdate: "restrict" }),
  automationEnabled: boolean("automation_enabled").notNull().default(false),
  refreshLeaseOwner: text("refresh_lease_owner"),
  refreshLeaseExpiresAt: time("refresh_lease_expires_at"),
  remoteRevocationStatus: text("remote_revocation_status").notNull().default("not_requested"),
  createdAt: time("created_at").notNull(),
  updatedAt: time("updated_at").notNull(),
}, (table) => [
  uniqueIndex("sepay_connection_creator_account_uidx").on(table.creatorUserId, table.providerEnvironment, table.accountFingerprint),
  uniqueIndex("sepay_connection_current_creator_uidx").on(table.creatorUserId, table.providerEnvironment).where(sql`${table.status} <> 'disconnected'`),
  index("sepay_connection_account_idx").on(table.accountFingerprint),
  check("sepay_connection_environment_check", sql`${table.providerEnvironment} in ('test','live')`),
  check("sepay_connection_status_check", sql`${table.status} in ('setup_pending','ready','paused','reconnect_required','disconnected')`),
  check("sepay_connection_version_check", sql`${table.version} > 0 and ${table.updatedAt} >= ${table.createdAt}`),
  check("sepay_connection_fingerprint_check", hmac(table.accountFingerprint)),
  check("sepay_connection_binding_check", sql`(${table.providerTenantId} is null and ${table.providerAccountId} is null) or (${table.providerTenantId} is not null and ${boundedIdentity(table.providerTenantId)} and ${table.providerAccountId} ~ '^[1-9][0-9]{0,39}$')`),
  check("sepay_connection_ready_check", sql`${table.status} <> 'ready' or (${table.currentRevisionId} is not null and ${table.providerTenantId} is not null and ${table.providerAccountId} is not null)`),
  check("sepay_connection_refresh_lease_check", sql`(${table.refreshLeaseOwner} is null and ${table.refreshLeaseExpiresAt} is null) or (${table.refreshLeaseOwner} is not null and ${boundedIdentity(table.refreshLeaseOwner)} and ${table.refreshLeaseExpiresAt} is not null)`),
  check("sepay_connection_revoke_check", sql`${table.remoteRevocationStatus} in ('not_requested','unknown','revoked')`),
]);

export const paymentsSepayConnectionRevisions = pgTable("payments_sepay_connection_revisions", {
  id: uuid("id").primaryKey(),
  connectionId: uuid("connection_id").notNull().references((): AnyPgColumn => paymentsSepayConnections.id, { onDelete: "restrict", onUpdate: "restrict" }),
  revisionNumber: integer("revision_number").notNull(),
  tokenGeneration: integer("token_generation").notNull().default(1),
  accessTokenEnvelope: jsonb("access_token_envelope").$type<EncryptionEnvelope>(),
  refreshTokenEnvelope: jsonb("refresh_token_envelope").$type<EncryptionEnvelope>(),
  webhookSecretEnvelope: jsonb("webhook_secret_envelope").$type<EncryptionEnvelope>().notNull(),
  accessTokenExpiresAt: time("access_token_expires_at"),
  scopes: text("scopes").array().notNull().default(sql`ARRAY[]::text[]`),
  providerTenantId: text("provider_tenant_id"),
  providerAccountId: text("provider_account_id"),
  providerBindingEnvelope: jsonb("provider_binding_envelope").$type<EncryptionEnvelope>(),
  capabilityEvidence: jsonb("capability_evidence").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: time("created_at").notNull(),
}, (table) => [
  uniqueIndex("sepay_revision_number_uidx").on(table.connectionId, table.revisionNumber),
  uniqueIndex("sepay_revision_connection_uidx").on(table.id, table.connectionId),
  check("sepay_revision_generation_check", sql`${table.revisionNumber} > 0 and ${table.tokenGeneration} > 0`),
  check("sepay_revision_webhook_envelope_check", envelope(table.webhookSecretEnvelope)),
  check("sepay_revision_grant_check", sql`(${table.accessTokenEnvelope} is null and ${table.refreshTokenEnvelope} is null and ${table.accessTokenExpiresAt} is null)
    or (${table.accessTokenEnvelope} is not null and ${table.refreshTokenEnvelope} is not null and ${table.accessTokenExpiresAt} > ${table.createdAt} and ${envelope(table.accessTokenEnvelope)} and ${envelope(table.refreshTokenEnvelope)})`),
  check("sepay_revision_scopes_check", sql`${table.scopes} <@ ARRAY['transaction:read','bank-account:read']::text[] and cardinality(${table.scopes}) <= 2 and array_position(${table.scopes}, null) is null`),
  check("sepay_revision_binding_check", sql`(${table.providerTenantId} is null and ${table.providerAccountId} is null) or (${table.providerTenantId} is not null and ${boundedIdentity(table.providerTenantId)} and ${table.providerAccountId} ~ '^[1-9][0-9]{0,39}$')`),
  check("sepay_revision_capabilities_check", sql`jsonb_typeof(${table.capabilityEvidence}) = 'object' and octet_length(${table.capabilityEvidence}::text) <= 4096
    and not jsonb_path_exists(${table.capabilityEvidence}, '$.* ? (@.type() != "boolean")')`),
  check("sepay_revision_provider_envelope_check", sql`${table.providerBindingEnvelope} is null or ${envelope(table.providerBindingEnvelope)}`),
]);

export const paymentsSepayOAuthAttempts = pgTable("payments_sepay_oauth_attempts", {
  id: uuid("id").primaryKey(),
  connectionId: uuid("connection_id").notNull().references(() => paymentsSepayConnections.id, { onDelete: "restrict", onUpdate: "restrict" }),
  stateHash: text("state_hash").notNull(),
  actorUserId: text("actor_user_id").notNull().references(() => identityUsers.id, { onDelete: "restrict", onUpdate: "restrict" }),
  actorSessionId: text("actor_session_id").notNull(),
  providerEnvironment: text("provider_environment").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  codeVerifierEnvelope: jsonb("code_verifier_envelope").$type<EncryptionEnvelope>().notNull(),
  expectedConnectionVersion: integer("expected_connection_version").notNull(),
  status: text("status").notNull().default("pending"),
  expiresAt: time("expires_at").notNull(),
  consumedAt: time("consumed_at"),
  createdAt: time("created_at").notNull(),
}, (table) => [
  uniqueIndex("sepay_oauth_state_uidx").on(table.stateHash),
  index("sepay_oauth_expiry_idx").on(table.expiresAt),
  check("sepay_oauth_state_check", hmac(table.stateHash)),
  check("sepay_oauth_environment_check", sql`${table.providerEnvironment} in ('test','live')`),
  check("sepay_oauth_actor_check", boundedIdentity(table.actorSessionId)),
  check("sepay_oauth_redirect_check", sql`char_length(${table.redirectUri}) between 1 and 2048 and ${table.redirectUri} !~ '[[:cntrl:]]'`),
  check("sepay_oauth_verifier_check", envelope(table.codeVerifierEnvelope)),
  check("sepay_oauth_version_check", sql`${table.expectedConnectionVersion} > 0`),
  check("sepay_oauth_time_check", sql`${table.expiresAt} > ${table.createdAt} and ${table.expiresAt} <= ${table.createdAt} + interval '15 minutes' and (${table.consumedAt} is null or (${table.consumedAt} >= ${table.createdAt} and ${table.consumedAt} < ${table.expiresAt}))`),
  check("sepay_oauth_status_check", sql`(${table.status} = 'pending' and ${table.consumedAt} is null) or (${table.status} in ('exchanging','completed','failed') and ${table.consumedAt} is not null)`),
]);

export const paymentsSepayAccountCutovers = pgTable("payments_sepay_account_cutovers", {
  id: uuid("id").primaryKey(),
  accountFingerprint: text("account_fingerprint").notNull(),
  creatorUserId: text("creator_user_id").notNull().references(() => identityUsers.id, { onDelete: "restrict", onUpdate: "restrict" }),
  connectionId: uuid("connection_id").notNull().references(() => paymentsSepayConnections.id, { onDelete: "restrict", onUpdate: "restrict" }),
  providerEnvironment: text("provider_environment").notNull(),
  providerTenantId: text("provider_tenant_id").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  actorSessionId: text("actor_session_id").notNull(),
  primaryAuthenticatedAt: time("primary_authenticated_at").notNull(),
  totpVerifiedAt: time("totp_verified_at"),
  cutoverAt: time("cutover_at").notNull(),
}, (table) => [
  uniqueIndex("sepay_cutover_fingerprint_uidx").on(table.accountFingerprint),
  check("sepay_cutover_fingerprint_check", hmac(table.accountFingerprint)),
  check("sepay_cutover_environment_check", sql`${table.providerEnvironment} in ('test','live')`),
  check("sepay_cutover_provider_check", sql`${boundedIdentity(table.providerTenantId)} and ${table.providerAccountId} ~ '^[1-9][0-9]{0,39}$'`),
  check("sepay_cutover_actor_check", boundedIdentity(table.actorSessionId)),
  check("sepay_cutover_assurance_check", sql`${table.primaryAuthenticatedAt} between ${table.cutoverAt} - interval '15 minutes' and ${table.cutoverAt}
    and (${table.totpVerifiedAt} is null or ${table.totpVerifiedAt} between ${table.cutoverAt} - interval '5 minutes' and ${table.cutoverAt})`),
]);

export const paymentsSepayInbox = pgTable("payments_sepay_inbox", {
  id: uuid("id").primaryKey(),
  connectionId: uuid("connection_id").notNull().references(() => paymentsSepayConnections.id, { onDelete: "restrict", onUpdate: "restrict" }),
  connectionRevisionId: uuid("connection_revision_id").notNull(),
  providerEventId: text("provider_event_id").notNull(),
  payloadDigest: text("payload_digest").notNull(),
  rawEnvelope: jsonb("raw_envelope").$type<EncryptionEnvelope>(),
  disposition: text("disposition").notNull(),
  normalizedFacts: jsonb("normalized_facts").$type<Record<string, unknown>>().notNull(),
  receivedAt: time("received_at").notNull(),
}, (table) => [
  uniqueIndex("sepay_inbox_event_uidx").on(table.connectionId, table.providerEventId),
  index("sepay_inbox_received_idx").on(table.receivedAt),
  foreignKey({ name: "sepay_inbox_revision_connection_fk", columns: [table.connectionRevisionId, table.connectionId], foreignColumns: [paymentsSepayConnectionRevisions.id, paymentsSepayConnectionRevisions.connectionId] }).onDelete("restrict").onUpdate("restrict"),
  check("sepay_inbox_event_id_check", sql`${table.providerEventId} ~ '^(0|[1-9][0-9]{0,39})$'`),
  check("sepay_inbox_digest_check", digest(table.payloadDigest)),
  check("sepay_inbox_disposition_check", sql`(${table.disposition} = 'accepted' and ${table.rawEnvelope} is not null and ${envelope(table.rawEnvelope)}) or (${table.disposition} = 'ignored' and ${table.rawEnvelope} is null)`),
  check("sepay_inbox_facts_check", sql`jsonb_typeof(${table.normalizedFacts}) = 'object' and octet_length(${table.normalizedFacts}::text) <= 4096`),
  check("sepay_inbox_ignored_minimal_check", sql`${table.disposition} <> 'ignored' or (${table.normalizedFacts}->>'reason' in ('outgoing','non_pawket','mock')
    and ${table.normalizedFacts} - 'reason' = '{}'::jsonb)`),
]);

export const paymentsSepayInboxConflicts = pgTable("payments_sepay_inbox_conflicts", {
  inboxId: uuid("inbox_id").primaryKey().references(() => paymentsSepayInbox.id, { onDelete: "restrict", onUpdate: "restrict" }),
  payloadDigest: text("payload_digest").notNull(),
  receivedAt: time("received_at").notNull(),
}, (table) => [check("sepay_conflict_digest_check", digest(table.payloadDigest))]);

export const paymentsSepayProcessing = pgTable("payments_sepay_processing", {
  inboxId: uuid("inbox_id").primaryKey().references(() => paymentsSepayInbox.id, { onDelete: "restrict", onUpdate: "restrict" }),
  status: text("status").notNull().default("pending"),
  version: integer("version").notNull().default(1),
  attempts: integer("attempts").notNull().default(0),
  availableAt: time("available_at").notNull(),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: time("lease_expires_at"),
  lastErrorCode: text("last_error_code"),
  updatedAt: time("updated_at").notNull(),
}, (table) => [
  index("sepay_processing_available_idx").on(table.status, table.availableAt),
  check("sepay_processing_status_check", sql`${table.status} in ('pending','processing','review_required','confirmed','ignored','dismissed')`),
  check("sepay_processing_attempt_check", sql`${table.version} > 0 and ${table.attempts} between 0 and 100`),
  check("sepay_processing_lease_check", sql`(${table.status} = 'processing' and ${table.leaseOwner} is not null and ${boundedIdentity(table.leaseOwner)} and ${table.leaseExpiresAt} is not null)
    or (${table.status} <> 'processing' and ${table.leaseOwner} is null and ${table.leaseExpiresAt} is null)`),
  check("sepay_processing_error_check", sql`${table.lastErrorCode} is null or ${table.lastErrorCode} ~ '^[a-z][a-z0-9_]{0,63}$'`),
]);

export const paymentsSepayDecisions = pgTable("payments_sepay_decisions", {
  id: uuid("id").primaryKey(),
  inboxId: uuid("inbox_id").notNull().references(() => paymentsSepayInbox.id, { onDelete: "restrict", onUpdate: "restrict" }),
  action: text("action").notNull(),
  reason: text("reason").notNull(),
  actorUserId: text("actor_user_id").references(() => identityUsers.id, { onDelete: "restrict", onUpdate: "restrict" }),
  actorSessionId: text("actor_session_id"),
  idempotencyKeyHash: text("idempotency_key_hash"),
  expectedVersion: integer("expected_version").notNull(),
  createdAt: time("created_at").notNull(),
}, (table) => [
  index("sepay_decision_inbox_idx").on(table.inboxId, table.createdAt),
  uniqueIndex("sepay_decision_idempotency_uidx").on(table.actorUserId, table.idempotencyKeyHash).where(sql`${table.actorUserId} is not null`),
  check("sepay_decision_action_check", sql`${table.action} in ('confirmed','review_required','ignored','retry','dismiss','reopen','conflict')`),
  check("sepay_decision_reason_check", sql`char_length(${table.reason}) between 1 and 500 and ${table.reason} !~ '[[:cntrl:]]'`),
  check("sepay_decision_version_check", sql`${table.expectedVersion} > 0`),
  check("sepay_decision_actor_check", sql`(${table.actorUserId} is null and ${table.actorSessionId} is null and ${table.idempotencyKeyHash} is null)
    or (${table.actorUserId} is not null and ${table.actorSessionId} is not null and ${boundedIdentity(table.actorSessionId)} and ${table.idempotencyKeyHash} is not null and ${hmac(table.idempotencyKeyHash)})`),
]);

export const paymentsSepayTransactions = pgTable("payments_sepay_transactions", {
  id: uuid("id").primaryKey(),
  providerEnvironment: text("provider_environment").notNull(),
  providerTenantId: text("provider_tenant_id").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  providerTransactionId: text("provider_transaction_id").notNull(),
  connectionId: uuid("connection_id").notNull().references(() => paymentsSepayConnections.id, { onDelete: "restrict", onUpdate: "restrict" }),
  connectionRevisionId: uuid("connection_revision_id").notNull(),
  connectionVersion: integer("connection_version").notNull(),
  inboxId: uuid("inbox_id").notNull().references(() => paymentsSepayInbox.id, { onDelete: "restrict", onUpdate: "restrict" }),
  paymentIntentId: uuid("payment_intent_id").notNull().references((): AnyPgColumn => paymentIntents.id, { onDelete: "restrict", onUpdate: "restrict" }),
  amountVnd: bigint("amount_vnd", { mode: "number" }).notNull(),
  referenceHash: text("reference_hash").notNull(),
  accountFingerprint: text("account_fingerprint").notNull(),
  transferAt: time("transfer_at").notNull(),
  verifiedAt: time("verified_at").notNull(),
  readbackDigest: text("readback_digest").notNull(),
}, (table) => [
  uniqueIndex("sepay_transaction_identity_uidx").on(table.providerEnvironment, table.providerTenantId, table.providerAccountId, table.providerTransactionId),
  uniqueIndex("sepay_transaction_intent_uidx").on(table.paymentIntentId),
  foreignKey({ name: "sepay_transaction_revision_connection_fk", columns: [table.connectionRevisionId, table.connectionId], foreignColumns: [paymentsSepayConnectionRevisions.id, paymentsSepayConnectionRevisions.connectionId] }).onDelete("restrict").onUpdate("restrict"),
  check("sepay_transaction_environment_check", sql`${table.providerEnvironment} in ('test','live')`),
  check("sepay_transaction_provider_check", sql`${boundedIdentity(table.providerTenantId)} and ${table.providerAccountId} ~ '^[1-9][0-9]{0,39}$' and ${table.providerTransactionId} ~ '^[1-9][0-9]{0,39}$'`),
  check("sepay_transaction_amount_check", sql`${table.amountVnd} between 1 and 9999999999999 and ${table.connectionVersion} > 0`),
  check("sepay_transaction_reference_check", hmac(table.referenceHash)),
  check("sepay_transaction_fingerprint_check", hmac(table.accountFingerprint)),
  check("sepay_transaction_digest_check", digest(table.readbackDigest)),
  check("sepay_transaction_time_check", sql`${table.transferAt} <= ${table.verifiedAt}`),
]);
