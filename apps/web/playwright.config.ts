import path from "node:path";

import { defineConfig } from "@playwright/test";

import { browserDatabaseUrl } from "./tests/increment-three-database";
import {
  INCREMENT_THREE_DISABLED_TEST,
  INCREMENT_THREE_ENABLED_TESTS,
} from "./tests/increment-three-environment";

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./tests/increment-three-database-global-setup.ts",
  outputDir: path.resolve(import.meta.dirname, ".playwright-artifacts", "legacy"),
  testMatch: "**/*.playwright.ts",
  testIgnore: [
    "auth-sso.playwright.ts",
    "tip-journey.playwright.ts",
    "owner-tip-policy.playwright.ts",
    "sepay-journey.playwright.ts",
    "commission-journey.playwright.ts",
    "commission-reference-files.playwright.ts",
    "commission-fulfillment.playwright.ts",
    "ui-foundation.playwright.ts",
    "ui-regression.playwright.ts",
    "resolution-ui.playwright.ts",
    "case-ui.playwright.ts",
    INCREMENT_THREE_DISABLED_TEST,
    ...INCREMENT_THREE_ENABLED_TESTS,
  ],
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4173",
    browserName: "chromium",
    timezoneId: "UTC",
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } }
      : {}),
  },
  webServer: {
    command:
      "node node_modules/next/dist/bin/next dev --webpack --hostname 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173/creator/apply",
    env: {
      NODE_ENV: "test",
      APP_ENV: "test",
      APP_REVISION: "playwright",
      CREATOR_PUBLISHING_MODE: "disabled",
      // Legacy fixtures must not inherit CI private-file credentials or scanner configuration.
      COMMISSION_FILES_MODE: "disabled",
      COMMISSION_FILE_RETENTION_MODE: "report_only",
      COMMISSION_FILES_S3_ENDPOINT: "",
      COMMISSION_FILES_S3_REGION: "",
      COMMISSION_FILES_S3_ACCESS_KEY_ID: "",
      COMMISSION_FILES_S3_SECRET_ACCESS_KEY: "",
      COMMISSION_FILES_QUARANTINE_BUCKET: "",
      COMMISSION_FILES_CLEAN_BUCKET: "",
      COMMISSION_FILES_CLAMD_HOST: "",
      DATABASE_URL: browserDatabaseUrl,
      VALKEY_URL: process.env.TEST_VALKEY_URL ?? "redis://127.0.0.1:6379",
      METRICS_TOKEN: "playwright-metrics-token-000000000000",
      APP_BASE_URL: "http://127.0.0.1:4173",
      AUTH_TRUSTED_ORIGINS: "http://127.0.0.1:4173",
      OIDC_ISSUER: "https://idp.example.invalid/application/o/pawket/",
      OIDC_CLIENT_ID: "pawket-synthetic",
      OIDC_PROVIDER_REVISION: "synthetic-v1",
      OIDC_CLIENT_SECRET: "synthetic-browser-client-secret-00000000",
      OIDC_ACCOUNT_PORTAL_URL: "https://idp.example.invalid/if/user/",
      PII_ACTIVE_KEY_ID: "playwright-pii-v1",
      PII_KEYRING_JSON: '{"playwright-pii-v1":"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="}',
      PII_LOOKUP_HMAC_KEY: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
      SECURITY_EMAIL_ADAPTER: "disabled",
      VERIFICATION_DEPOSIT_AMOUNT_VND: "1000",
      OPERATING_BANK_BIN: "000000",
      OPERATING_BANK_ACCOUNT_NUMBER: "000000",
      OPERATING_BANK_ACCOUNT_NAME: "PAWKET PLAYWRIGHT",
      VN_BUSINESS_CALENDAR_VERSION: "vn-playwright-v1",
      VN_BUSINESS_HOLIDAYS: "[]",
      AUTH_USER_ABSOLUTE_TTL_SECONDS: "2592000",
      AUTH_USER_IDLE_TTL_SECONDS: "604800",
      AUTH_OWNER_ABSOLUTE_TTL_SECONDS: "43200",
      AUTH_OWNER_IDLE_TTL_SECONDS: "1800",
      AUTH_PRIMARY_STEP_UP_TTL_SECONDS: "3600",
      AUTH_OWNER_TOTP_STEP_UP_TTL_SECONDS: "3600",
    },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
