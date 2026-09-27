import path from "node:path";
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
import { browserDatabaseConfiguration, browserDatabaseUrl } from "./tests/increment-three-database";
if (browserDatabaseConfiguration.targetDatabaseName !== "pawket_increment6_commissions_browser") throw new Error("Increment 6 requires its dedicated disposable browser database");
export default defineConfig({ ...base, globalSetup: "./tests/increment-six-global-setup.ts", testMatch: ["commission-journey.playwright.ts"], testIgnore: [], timeout: 60_000,
  fullyParallel: false, workers: 1, outputDir: path.resolve(import.meta.dirname, ".playwright-artifacts", "increment-six"),
  use: { ...base.use, baseURL: "http://127.0.0.1:4181", locale: "vi-VN", colorScheme: "light", contextOptions: { reducedMotion: "reduce" }, extraHTTPHeaders: { "x-real-ip": "127.0.0.1" } },
  webServer: ([4181, 4182] as const).map((port) => ({
    command: `node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}/sign-in`, reuseExistingServer: false, timeout: 120_000,
    env: { ...(base.webServer && !Array.isArray(base.webServer) ? base.webServer.env : {}),
      DATABASE_URL: browserDatabaseUrl, APP_BASE_URL: `http://127.0.0.1:${port}`, AUTH_TRUSTED_ORIGINS: `http://127.0.0.1:${port}`,
      VALKEY_URL: process.env.TEST_VALKEY_URL ?? "redis://127.0.0.1:16379/0", CREATOR_PUBLISHING_MODE: "general_audience", PUBLIC_MEDIA_RETENTION_MODE: "report_only",
      TIP_PAYMENTS_MODE: "disabled", COMMISSION_INTAKE_MODE: port === 4181 ? "enabled" : "disabled", COMMISSION_PAYMENTS_MODE: port === 4181 ? "manual_only" : "disabled",
      COMMISSION_REQUEST_LIMIT: "100", COMMISSION_COMMAND_LIMIT: "1000", COMMISSION_READ_LIMIT: "2000",
    },
  })),
});
