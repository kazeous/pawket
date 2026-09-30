import { sql, type SQLWrapper } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Drizzle Kit requires extensionless schema imports.
// @ts-ignore Drizzle Kit resolves this TypeScript schema without the emitted suffix.
import { identityAccounts, identitySessions, identityStepUpProofs, identityUsers } from "./identity-core";

type SecretEnvelope = { version: 1; algorithm: "A256GCM"; keyId: string; nonce: string; ciphertext: string; authenticationTag: string };
const instant = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const envelopeCheck = (column: SQLWrapper, limit = 24000) => sql`coalesce(
  jsonb_typeof(${column}) = 'object' and octet_length(${column}::text) <= ${sql.raw(String(limit))}
  and ${column}->'version' = '1'::jsonb and ${column}->>'algorithm' = 'A256GCM'
  and ${column}->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  and ${column}->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
  and ${column}->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
  and ${column}->>'authenticationTag' ~ '^[A-Za-z0-9_-]{22}$'
  and ${column} - ARRAY['version','algorithm','keyId','nonce','ciphertext','authenticationTag'] = '{}'::jsonb, false)`;

/** OIDC state is durable across instances; PKCE material never reaches browser storage. */
export const identityOidcTransactions = pgTable("identity_oidc_transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  stateHash: text("state_hash").notNull(),
  browserBindingHash: text("browser_binding_hash").notNull(),
  nonce: text("nonce").notNull(),
  verifierEnvelope: jsonb("verifier_envelope").$type<SecretEnvelope>(),
  purpose: text("purpose").notNull(),
  status: text("status").notNull().default("pending"),
  issuer: text("issuer").notNull(),
  clientId: text("client_id").notNull(),
  providerRevision: text("provider_revision").notNull(),
  expectedUserId: text("expected_user_id").references(() => identityUsers.id, { onDelete: "restrict" }),
  expectedSessionId: text("expected_session_id").references(() => identitySessions.id, { onDelete: "restrict" }),
  expectedAuthorizationVersion: integer("expected_authorization_version"),
  expectedSubject: text("expected_subject"),
  actionClass: text("action_class"),
  commandDigest: text("command_digest"),
  returnPath: text("return_path").notNull(),
  createdAt: instant("created_at").notNull(),
  expiresAt: instant("expires_at").notNull(),
  claimedAt: instant("claimed_at"),
  completedAt: instant("completed_at"),
}, (t) => [
  uniqueIndex("identity_oidc_transactions_state_uidx").on(t.stateHash),
  index("identity_oidc_transactions_expiry_idx").on(t.expiresAt),
  foreignKey({ name: "identity_oidc_transactions_actor_fk", columns: [t.expectedUserId, t.expectedSessionId], foreignColumns: [identitySessions.userId, identitySessions.id] }).onDelete("restrict"),
  check("identity_oidc_transactions_verifier_check", sql`${t.verifierEnvelope} is null or ${envelopeCheck(t.verifierEnvelope)}`),
  check("identity_oidc_transactions_purpose_check", sql`${t.purpose} in ('login', 'lease_check', 'step_up', 'owner_link')`),
  check("identity_oidc_transactions_status_check", sql`${t.status} in ('pending', 'exchanging', 'consumed', 'failed')`),
  check("identity_oidc_transactions_deadline_check", sql`${t.expiresAt} > ${t.createdAt} and ${t.expiresAt} <= ${t.createdAt} + interval '10 minutes'`),
  check("identity_oidc_transactions_actor_check", sql`(${t.purpose} = 'login' and ${t.expectedUserId} is null and ${t.expectedSessionId} is null and ${t.expectedSubject} is null and ${t.expectedAuthorizationVersion} is null)
    or (${t.purpose} = 'owner_link' and ${t.expectedUserId} is not null and ${t.expectedSubject} is not null and ${t.expectedAuthorizationVersion} is not null and ${t.expectedAuthorizationVersion} > 0)
    or (${t.purpose} in ('lease_check', 'step_up') and ${t.expectedUserId} is not null and ${t.expectedSessionId} is not null and ${t.expectedSubject} is not null and ${t.expectedAuthorizationVersion} is not null and ${t.expectedAuthorizationVersion} > 0)`),
  check("identity_oidc_transactions_action_check", sql`${t.purpose} <> 'step_up' or (${t.actionClass} is not null and ${t.commandDigest} is not null)`),
  check("identity_oidc_transactions_processing_check", sql`(${t.status} = 'pending' and ${t.claimedAt} is null and ${t.completedAt} is null and ${t.verifierEnvelope} is not null)
    or (${t.status} = 'exchanging' and ${t.claimedAt} is not null and ${t.completedAt} is null and ${t.verifierEnvelope} is not null)
    or (${t.status} in ('consumed', 'failed') and ${t.completedAt} is not null and ${t.verifierEnvelope} is null)`),
]);

/** Parent session keeps its ID for financial/audit references. No local TOTP row is fabricated. */
export const identityOidcSessions = pgTable("identity_oidc_sessions", {
  sessionId: text("session_id").primaryKey().references(() => identitySessions.id, { onDelete: "restrict" }),
  userId: text("user_id").notNull(),
  accountId: text("account_id").notNull().references(() => identityAccounts.id, { onDelete: "restrict" }),
  clientId: text("client_id").notNull(),
  providerRevision: text("provider_revision").notNull(),
  sid: text("sid").notNull(),
  primaryMethod: text("primary_method").notNull(),
  totpStatus: text("totp_status").notNull(),
  evidenceVerifiedAt: instant("evidence_verified_at").notNull(),
  leaseStartedAt: instant("lease_started_at").notNull(),
  idpValidUntil: instant("idp_valid_until").notNull(),
  transactionId: uuid("transaction_id").notNull().references(() => identityOidcTransactions.id, { onDelete: "restrict" }),
}, (t) => [
  foreignKey({ name: "identity_oidc_sessions_actor_fk", columns: [t.userId, t.sessionId], foreignColumns: [identitySessions.userId, identitySessions.id] }).onDelete("restrict"),
  foreignKey({ name: "identity_oidc_sessions_account_actor_fk", columns: [t.userId, t.accountId], foreignColumns: [identityAccounts.userId, identityAccounts.id] }).onDelete("restrict"),
  index("identity_oidc_sessions_account_sid_idx").on(t.accountId, t.clientId, t.sid),
  index("identity_oidc_sessions_lease_idx").on(t.idpValidUntil),
  check("identity_oidc_sessions_primary_method_check", sql`${t.primaryMethod} in ('password', 'source')`),
  check("identity_oidc_sessions_totp_status_check", sql`${t.totpStatus} in ('enrolled', 'not_enrolled', 'unknown')`),
  check("identity_oidc_sessions_lease_check", sql`${t.idpValidUntil} > ${t.leaseStartedAt} and ${t.idpValidUntil} <= ${t.leaseStartedAt} + interval '5 minutes' and ${t.evidenceVerifiedAt} >= ${t.leaseStartedAt}`),
]);

/** Revocation fences serialize callbacks with logout, including when logout arrives first. */
export const identityOidcRevocations = pgTable("identity_oidc_revocations", {
  id: uuid("id").primaryKey().defaultRandom(),
  issuer: text("issuer").notNull(),
  clientId: text("client_id").notNull(),
  kind: text("kind").notNull(),
  subjectKey: text("subject_key").notNull(),
  revokedThrough: instant("revoked_through").notNull(),
  receivedAt: instant("received_at").notNull(),
}, (t) => [
  uniqueIndex("identity_oidc_revocations_subject_uidx").on(t.issuer, t.clientId, t.kind, t.subjectKey),
  check("identity_oidc_revocations_kind_check", sql`${t.kind} in ('sid', 'sub', 'local_sub')`),
]);

export const identityOidcLogoutEvents = pgTable("identity_oidc_logout_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  issuer: text("issuer").notNull(),
  clientId: text("client_id").notNull(),
  jtiHash: text("jti_hash").notNull(),
  receivedAt: instant("received_at").notNull(),
  expiresAt: instant("expires_at").notNull(),
}, (t) => [
  uniqueIndex("identity_oidc_logout_events_jti_uidx").on(t.issuer, t.clientId, t.jtiHash),
  index("identity_oidc_logout_events_expiry_idx").on(t.expiresAt),
  check("identity_oidc_logout_events_expiry_check", sql`${t.expiresAt} > ${t.receivedAt}`),
]);

/** Operator pins this mapping before the browser proves ownership of the IdP account. */
export const identityOidcOwnerLinks = pgTable("identity_oidc_owner_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => identityUsers.id, { onDelete: "restrict" }),
  issuer: text("issuer").notNull(),
  clientId: text("client_id").notNull(),
  subject: text("subject").notNull(),
  providerRevision: text("provider_revision").notNull(),
  invitationHash: text("invitation_hash").notNull(),
  approvedAt: instant("approved_at").notNull(),
  expiresAt: instant("expires_at").notNull(),
  consumedAt: instant("consumed_at"),
}, (t) => [
  uniqueIndex("identity_oidc_owner_links_invitation_uidx").on(t.invitationHash),
  uniqueIndex("identity_oidc_owner_links_pending_user_uidx").on(t.userId).where(sql`${t.consumedAt} is null`),
  check("identity_oidc_owner_links_expiry_check", sql`${t.expiresAt} > ${t.approvedAt} and ${t.expiresAt} <= ${t.approvedAt} + interval '1 hour'`),
]);

export const identityOidcPendingCommands = pgTable("identity_oidc_pending_commands", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => identityUsers.id, { onDelete: "restrict" }),
  sessionId: text("session_id").notNull().references(() => identitySessions.id, { onDelete: "restrict" }),
  authorizationVersion: integer("authorization_version").notNull(),
  actionClass: text("action_class").notNull(),
  commandDigest: text("command_digest").notNull(),
  payloadEnvelope: jsonb("payload_envelope").$type<SecretEnvelope>(),
  createdAt: instant("created_at").notNull(),
  expiresAt: instant("expires_at").notNull(),
  consumedAt: instant("consumed_at"),
  proofId: uuid("proof_id").references(() => identityStepUpProofs.id, { onDelete: "restrict" }),
}, (t) => [
  index("identity_oidc_pending_commands_expiry_idx").on(t.expiresAt),
  foreignKey({ name: "identity_oidc_pending_commands_actor_fk", columns: [t.userId, t.sessionId], foreignColumns: [identitySessions.userId, identitySessions.id] }).onDelete("restrict"),
  check("identity_oidc_pending_commands_envelope_check", sql`${t.payloadEnvelope} is null or ${envelopeCheck(t.payloadEnvelope, 200000)}`),
  check("identity_oidc_pending_commands_version_check", sql`${t.authorizationVersion} > 0`),
  check("identity_oidc_pending_commands_expiry_check", sql`${t.expiresAt} > ${t.createdAt} and ${t.expiresAt} <= ${t.createdAt} + interval '10 minutes'`),
  check("identity_oidc_pending_commands_payload_check", sql`(${t.consumedAt} is null and ${t.payloadEnvelope} is not null) or (${t.consumedAt} is not null and ${t.payloadEnvelope} is null)`),
]);

/** Legacy proofs remain historical; only proofs with this binding work after cutover. */
export const identityOidcProofBindings = pgTable("identity_oidc_proof_bindings", {
  proofId: uuid("proof_id").primaryKey().references(() => identityStepUpProofs.id, { onDelete: "restrict" }),
  authorizationVersion: integer("authorization_version").notNull(),
  commandDigest: text("command_digest").notNull(),
  providerRevision: text("provider_revision").notNull(),
  transactionId: uuid("transaction_id").notNull().references(() => identityOidcTransactions.id, { onDelete: "restrict" }),
}, (t) => [
  check("identity_oidc_proof_bindings_version_check", sql`${t.authorizationVersion} > 0`),
  check("identity_oidc_proof_bindings_digest_check", sql`${t.commandDigest} ~ '^hmac-sha256:v1:[A-Za-z0-9_-]{43}$'`),
]);

/** One-way cutover marker. Rollback keeps expanded schema and requires fresh SSO. */
export const identityOidcCutover = pgTable("identity_oidc_cutover", {
  id: integer("id").primaryKey(),
  issuer: text("issuer").notNull(),
  clientId: text("client_id").notNull(),
  providerRevision: text("provider_revision").notNull(),
  applicationRevision: text("application_revision").notNull(),
  ownerUserId: text("owner_user_id").notNull().references(() => identityUsers.id, { onDelete: "restrict" }),
  operatorReference: text("operator_reference").notNull(),
  acceptanceReference: text("acceptance_reference").notNull(),
  backupReference: text("backup_reference").notNull(),
  recoveryReference: text("recovery_reference").notNull(),
  activatedAt: instant("activated_at").notNull(),
  rollbackUntil: instant("rollback_until").notNull(),
  backupRetainedUntil: instant("backup_retained_until").notNull(),
}, (t) => [
  check("identity_oidc_cutover_singleton_check", sql`${t.id} = 1`),
  check("identity_oidc_cutover_window_check", sql`${t.rollbackUntil} > ${t.activatedAt} and ${t.backupRetainedUntil} >= ${t.rollbackUntil}`),
]);
