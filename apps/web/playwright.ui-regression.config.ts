import path from "node:path";

import { defineConfig } from "@playwright/test";

import base from "./playwright.config";

// A production build is required. Reuse the guarded, synthetic Increment 3
// fixtures so protected pages exercise real server-side authorization.
export default defineConfig({
  ...base,
  globalSetup: "./tests/increment-three-global-setup.ts",
  testMatch: "ui-regression.playwright.ts",
  testIgnore: [],
  outputDir: path.resolve(import.meta.dirname, ".playwright-artifacts", "ui-regression"),
  snapshotPathTemplate: "{testDir}/ui-regression-snapshots/{platform}/{arg}{ext}",
  updateSnapshots: "none",
  use: {
    ...base.use,
    baseURL: "http://127.0.0.1:4176",
    locale: "vi-VN",
    contextOptions: { reducedMotion: "reduce" },
    colorScheme: "light",
  },
  webServer: {
    command: "node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 4176",
    url: "http://127.0.0.1:4176/sign-in",
    env: {
      ...(base.webServer && !Array.isArray(base.webServer) ? base.webServer.env : {}),
      APP_BASE_URL: "http://127.0.0.1:4176",
      AUTH_TRUSTED_ORIGINS: "http://127.0.0.1:4176",
      CREATOR_PUBLISHING_MODE: "disabled",
      PUBLIC_MEDIA_RETENTION_MODE: "report_only",
      TIP_PAYMENTS_MODE: "disabled",
    },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
