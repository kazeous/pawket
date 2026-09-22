import path from "node:path";
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
import { browserDatabaseConfiguration, browserDatabaseUrl } from "./tests/increment-three-database";

// Reuse the guarded disposable-database/sentinel mechanism, with a separate
// explicitly named target so Increment 3 browser fixtures stay untouched.
if (browserDatabaseConfiguration.targetDatabaseName !== "pawket_increment4_tips_browser") {
  throw new Error("Increment 4 requires the dedicated pawket_increment4_tips_browser target");
}
export default defineConfig({
  ...base,
  globalSetup: "./tests/increment-four-global-setup.ts",
  testMatch: ["tip-journey.playwright.ts", "owner-tip-policy.playwright.ts"], testIgnore: [], timeout: 60_000,
  fullyParallel: false, workers: 1,
  outputDir: path.resolve(import.meta.dirname, ".playwright-artifacts", "increment-four"),
  use: { ...base.use, baseURL: "http://127.0.0.1:4177", locale: "vi-VN", colorScheme: "light",
    contextOptions: { reducedMotion: "reduce" }, extraHTTPHeaders: { "x-real-ip": "127.0.0.1" } },
  webServer: ([[4177, "manual_only"], [4178, "disabled"]] as const).map(([port, mode]) => ({
    command: `node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}/sign-in`, reuseExistingServer: false, timeout: 120_000,
    env: { ...(base.webServer && !Array.isArray(base.webServer) ? base.webServer.env : {}),
      DATABASE_URL: browserDatabaseUrl, APP_BASE_URL: `http://127.0.0.1:${port}`, AUTH_TRUSTED_ORIGINS: `http://127.0.0.1:${port}`,
      TIP_PAYMENTS_MODE: mode, CREATOR_PUBLISHING_MODE: "general_audience", PUBLIC_MEDIA_RETENTION_MODE: "report_only",
      TIP_CREATE_IP_LIMIT: "100", TIP_CREATE_CREATOR_LIMIT: "1000", TIP_OPEN_IP_LIMIT: "20", TIP_OPEN_CREATOR_LIMIT: "1000",
    },
  })),
});
