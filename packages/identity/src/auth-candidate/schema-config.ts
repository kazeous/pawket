import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { twoFactor } from "better-auth/plugins";

import { hashPassword, verifyPassword } from "./password.js";
import { candidateSessionAdditionalFields, sessionAssuranceForPath } from "./session-fields.js";

export const auth = betterAuth({
  appName: "Pawket",
  baseURL: "http://localhost:3000",
  secret: "schema-generation-only-secret-32-characters",
  database: drizzleAdapter({} as never, { provider: "pg", transaction: true }),
  user: { modelName: "identityUsers" },
  session: {
    modelName: "identitySessions",
    cookieCache: { enabled: false },
    additionalFields: candidateSessionAdditionalFields,
  },
  account: {
    modelName: "identityAccounts",
    storeStateStrategy: "database",
    accountLinking: {
      enabled: true,
      disableImplicitLinking: true,
      allowDifferentEmails: false,
    },
  },
  verification: {
    modelName: "identityVerifications",
    storeIdentifier: "hashed",
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    autoSignIn: false,
    minPasswordLength: 15,
    maxPasswordLength: 128,
    resetPasswordTokenExpiresIn: 1_800,
    revokeSessionsOnPasswordReset: true,
    password: { hash: hashPassword, verify: verifyPassword },
  },
  socialProviders: {
    google: {
      clientId: "schema-google-client-id",
      clientSecret: "schema-google-client-secret",
      scope: ["openid", "email", "profile"],
      requireEmailVerification: true,
    },
    discord: {
      clientId: "schema-discord-client-id",
      clientSecret: "schema-discord-client-secret",
      scope: ["identify", "email"],
      requireEmailVerification: true,
    },
  },
  databaseHooks: {
    session: {
      create: {
        before: async (session, context) => ({
          data: {
            ...session,
            ...sessionAssuranceForPath(context?.path ?? "", new Date()),
          },
        }),
      },
    },
  },
  plugins: [
    twoFactor({
      issuer: "Pawket",
      twoFactorTable: "identityTwoFactors",
      twoFactorCookieMaxAge: 600,
      trustDeviceMaxAge: 0,
      accountLockout: { enabled: true, maxFailedAttempts: 5, durationSeconds: 900 },
      backupCodeOptions: {
        amount: 0,
        customBackupCodesGenerate: () => [],
        storeBackupCodes: "encrypted",
      },
    }),
  ],
});
