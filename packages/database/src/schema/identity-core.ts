import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

type EncryptedFieldEnvelope = {
  version: 1;
  algorithm: "A256GCM";
  keyId: string;
  nonce: string;
  ciphertext: string;
  authenticationTag: string;
};

export const identityUsers = pgTable(
  "identity_users",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    canonicalEmail: text("canonical_email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true, mode: "date" }),
    emailVerificationProvenance: text("email_verification_provenance"),
    image: text("image"),
    accessStatus: text("access_status").notNull().default("active"),
    authorizationVersion: integer("authorization_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("identity_users_canonical_email_uidx").on(table.canonicalEmail),
    check(
      "identity_users_access_status_check",
      sql`${table.accessStatus} in ('active', 'access_suspended', 'closed')`,
    ),
    check("identity_users_authorization_version_check", sql`${table.authorizationVersion} > 0`),
    check(
      "identity_users_verification_evidence_check",
      sql`(${table.emailVerified} = false and ${table.emailVerifiedAt} is null and ${table.emailVerificationProvenance} is null)
        or (${table.emailVerified} = true and ${table.emailVerifiedAt} is not null and ${table.emailVerificationProvenance} in ('password_email_challenge', 'provider_assertion'))`,
    ),
  ],
);

export const identityEmailAddresses = pgTable(
  "identity_email_addresses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => identityUsers.id, { onDelete: "cascade", onUpdate: "restrict" }),
    displayEmail: text("display_email").notNull(),
    canonicalEmail: text("canonical_email").notNull(),
    status: text("status").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "date" }),
    verificationProvenance: text("verification_provenance"),
    replacedAt: timestamp("replaced_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("identity_email_addresses_canonical_uidx").on(table.canonicalEmail),
    uniqueIndex("identity_email_addresses_primary_user_uidx")
      .on(table.userId)
      .where(sql`${table.status} = 'primary'`),
    index("identity_email_addresses_user_idx").on(table.userId),
    check(
      "identity_email_addresses_status_check",
      sql`${table.status} in ('pending', 'primary', 'previous')`,
    ),
    check(
      "identity_email_addresses_verification_check",
      sql`(${table.verifiedAt} is null and ${table.verificationProvenance} is null)
        or (${table.verifiedAt} is not null and ${table.verificationProvenance} in ('password_email_challenge', 'provider_assertion'))`,
    ),
    check(
      "identity_email_addresses_replaced_check",
      sql`(${table.status} = 'previous' and ${table.replacedAt} is not null)
        or (${table.status} <> 'previous' and ${table.replacedAt} is null)`,
    ),
  ],
);

export const identityAccounts = pgTable(
  "identity_accounts",
  {
    id: text("id").primaryKey(),
    issuer: text("issuer").notNull().default("pawket"),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => identityUsers.id, { onDelete: "cascade", onUpdate: "restrict" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    scope: text("scope"),
    password: text("password_hash"),
    passwordHashVersion: integer("password_hash_version"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("identity_accounts_issuer_account_uidx").on(table.issuer, table.accountId),
    index("identity_accounts_user_idx").on(table.userId),
    check(
      "identity_accounts_no_provider_tokens_check",
      sql`${table.accessToken} is null and ${table.refreshToken} is null and ${table.idToken} is null`,
    ),
    check(
      "identity_accounts_password_version_check",
      sql`(${table.password} is null and ${table.passwordHashVersion} is null)
        or (${table.password} is not null and ${table.passwordHashVersion} is not null and ${table.passwordHashVersion} > 0)`,
    ),
  ],
);

export const identitySessions = pgTable(
  "identity_sessions",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    token: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    ipAddress: text("network_key"),
    userAgent: text("user_agent_family"),
    userId: text("user_id")
      .notNull()
      .references(() => identityUsers.id, { onDelete: "cascade", onUpdate: "restrict" }),
    assuranceState: text("assurance_state").notNull().default("provisional"),
    primaryAuthenticatedAt: timestamp("primary_authenticated_at", {
      withTimezone: true,
      mode: "date",
    }),
    mfaVerifiedAt: timestamp("mfa_verified_at", { withTimezone: true, mode: "date" }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    absoluteExpiresAt: timestamp("absolute_expires_at", { withTimezone: true, mode: "date" })
      .notNull(),
    idleExpiresAt: timestamp("idle_expires_at", { withTimezone: true, mode: "date" }).notNull(),
    authorizationVersion: integer("authorization_version").notNull().default(1),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    revocationReason: text("revocation_reason"),
  },
  (table) => [
    uniqueIndex("identity_sessions_token_hash_uidx").on(table.token),
    index("identity_sessions_user_idx").on(table.userId),
    index("identity_sessions_expiry_idx").on(table.expiresAt),
    check(
      "identity_sessions_assurance_state_check",
      sql`${table.assuranceState} in ('provisional', 'mfa_pending', 'active')`,
    ),
    check(
      "identity_sessions_expiry_check",
      sql`${table.expiresAt} <= ${table.absoluteExpiresAt}
        and ${table.expiresAt} <= ${table.idleExpiresAt}
        and ${table.lastUsedAt} <= ${table.idleExpiresAt}
        and ${table.createdAt} < ${table.absoluteExpiresAt}`,
    ),
    check(
      "identity_sessions_revocation_check",
      sql`(${table.revokedAt} is null and ${table.revocationReason} is null)
        or (${table.revokedAt} is not null and ${table.revocationReason} is not null)`,
    ),
  ],
);

export const identityVerifications = pgTable(
  "identity_verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier_hash").notNull(),
    value: text("token_hash").notNull(),
    purpose: text("purpose").notNull().default("better_auth"),
    userId: text("user_id").references(() => identityUsers.id, {
      onDelete: "cascade",
      onUpdate: "restrict",
    }),
    targetEmailCanonical: text("target_email_canonical"),
    targetEmail: text("target_email"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
    attemptCount: integer("attempt_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("identity_verifications_identifier_idx").on(table.identifier),
    uniqueIndex("identity_verifications_token_hash_uidx").on(table.value),
    index("identity_verifications_user_purpose_idx").on(table.userId, table.purpose),
    check(
      "identity_verifications_purpose_check",
      sql`${table.purpose} in ('better_auth', 'email_verification', 'password_reset', 'email_change')`,
    ),
    check("identity_verifications_attempt_count_check", sql`${table.attemptCount} >= 0`),
    check("identity_verifications_expiry_check", sql`${table.expiresAt} > ${table.createdAt}`),
  ],
);

export const identitySecurityThrottles = pgTable(
  "identity_security_throttles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: text("scope").notNull(),
    subjectHmac: text("subject_hmac").notNull(),
    action: text("action").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true, mode: "date" }).notNull(),
    blockedUntil: timestamp("blocked_until", { withTimezone: true, mode: "date" }),
    riskLevel: text("risk_level").notNull().default("normal"),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("identity_security_throttles_subject_uidx").on(
      table.scope,
      table.subjectHmac,
      table.action,
    ),
    index("identity_security_throttles_blocked_idx").on(table.blockedUntil),
    check("identity_security_throttles_scope_check", sql`${table.scope} in ('account', 'network')`),
    check(
      "identity_security_throttles_risk_check",
      sql`${table.riskLevel} in ('normal', 'elevated', 'challenge_required')`,
    ),
    check("identity_security_throttles_attempt_count_check", sql`${table.attemptCount} >= 0`),
  ],
);

export const identityEmailHandoffs = pgTable(
  "identity_email_handoffs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    purpose: text("purpose").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => identityUsers.id, { onDelete: "cascade", onUpdate: "restrict" }),
    destinationEnvelope: jsonb("destination_envelope").$type<EncryptedFieldEnvelope>().notNull(),
    secretEnvelope: jsonb("secret_envelope").$type<EncryptedFieldEnvelope | null>(),
    templateData: jsonb("template_data").$type<Record<string, string>>().notNull().default({}),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true, mode: "date" }),
    lockedBy: text("locked_by"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "date" }),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
    failureCode: text("failure_code"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("identity_email_handoffs_pending_idx").on(table.status, table.availableAt),
    check(
      "identity_email_handoffs_purpose_check",
      sql`${table.purpose} in ('email_verification', 'password_reset', 'email_change', 'security_notice')`,
    ),
    check(
      "identity_email_handoffs_status_check",
      sql`${table.status} in ('pending', 'processing', 'sent', 'failed')`,
    ),
    check("identity_email_handoffs_attempts_check", sql`${table.attempts} >= 0`),
    check(
      "identity_email_handoffs_lease_check",
      sql`(${table.lockedAt} is null and ${table.lockedBy} is null and ${table.leaseExpiresAt} is null)
        or (${table.lockedAt} is not null and ${table.lockedBy} is not null and ${table.leaseExpiresAt} is not null)`,
    ),
  ],
);
