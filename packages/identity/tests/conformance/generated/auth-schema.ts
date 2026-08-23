import { relations } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const identityUsers = pgTable("identity_users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
  twoFactorEnabled: boolean("two_factor_enabled").default(false),
});

export const identitySessions = pgTable(
  "identity_sessions",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => identityUsers.id, { onDelete: "cascade" }),
    primaryAuthenticatedAt: timestamp("primary_authenticated_at"),
    mfaVerifiedAt: timestamp("mfa_verified_at"),
    lastUsedAt: timestamp("last_used_at"),
  },
  (table) => [index("identitySessions_userId_idx").on(table.userId)],
);

export const identityAccounts = pgTable(
  "identity_accounts",
  {
    id: text("id").primaryKey(),
    issuer: text("issuer").notNull(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => identityUsers.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("identityAccounts_issuer_accountId_uidx").on(
      table.issuer,
      table.accountId,
    ),
    index("identityAccounts_userId_idx").on(table.userId),
  ],
);

export const identityVerifications = pgTable(
  "identity_verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("identityVerifications_identifier_idx").on(table.identifier),
  ],
);

export const identityTwoFactors = pgTable(
  "identity_two_factors",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => identityUsers.id, { onDelete: "cascade" }),
    verified: boolean("verified").default(true),
    failedVerificationCount: integer("failed_verification_count").default(0),
    lockedUntil: timestamp("locked_until"),
  },
  (table) => [
    index("identityTwoFactors_secret_idx").on(table.secret),
    index("identityTwoFactors_userId_idx").on(table.userId),
  ],
);

export const identityUsersRelations = relations(identityUsers, ({ many }) => ({
  identitySessionss: many(identitySessions),
  identityAccountss: many(identityAccounts),
  identityTwoFactorss: many(identityTwoFactors),
}));

export const identitySessionsRelations = relations(
  identitySessions,
  ({ one }) => ({
    identityUsers: one(identityUsers, {
      fields: [identitySessions.userId],
      references: [identityUsers.id],
    }),
  }),
);

export const identityAccountsRelations = relations(
  identityAccounts,
  ({ one }) => ({
    identityUsers: one(identityUsers, {
      fields: [identityAccounts.userId],
      references: [identityUsers.id],
    }),
  }),
);

export const identityTwoFactorsRelations = relations(
  identityTwoFactors,
  ({ one }) => ({
    identityUsers: one(identityUsers, {
      fields: [identityTwoFactors.userId],
      references: [identityUsers.id],
    }),
  }),
);
