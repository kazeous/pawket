import { defineConfig } from "@playwright/test";

import base from "./playwright.config";
import { prepareIncrementThreeDatabase } from "./tests/increment-three-database";

await prepareIncrementThreeDatabase();

const webStart = process.env.PAWKET_DIRECT_BROWSER_BINARIES === "1"
  ? "node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 4174"
  : "pnpm --filter @pawket/web start --port 4174";

export default defineConfig({
  ...base,
  globalSetup: "./tests/increment-three-global-setup.ts",
  testMatch: "increment-three-disabled.playwright.ts",
  testIgnore: [],
  use: { ...base.use, baseURL: "http://127.0.0.1:4174" },
  webServer: {
    command: webStart,
    url: "http://127.0.0.1:4174/creator",
    env: {
      ...(base.webServer && !Array.isArray(base.webServer) ? base.webServer.env : {}),
      DATABASE_URL: "postgresql://pawket:pawket_dev_only@127.0.0.1:5432/pawket_task15_browser",
      APP_BASE_URL: "http://127.0.0.1:4174",
      AUTH_TRUSTED_ORIGINS: "http://127.0.0.1:4174",
      CREATOR_PUBLISHING_MODE: "disabled",
    },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
