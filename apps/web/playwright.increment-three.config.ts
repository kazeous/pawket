import { execFileSync } from "node:child_process";
import path from "node:path";

import { defineConfig } from "@playwright/test";

import base from "./playwright.config";
import { browserDatabaseUrl } from "./tests/increment-three-database";
import {
  INCREMENT_THREE_ENABLED_TESTS,
  incrementThreeStorageEnvironment,
  resolveIncrementThreeBrowserValkeyUrl,
  resolveIncrementThreeStorageFixture,
} from "./tests/increment-three-environment";

const directBinaries = process.env.PAWKET_DIRECT_BROWSER_BINARIES === "1";
const workspaceRoot = path.resolve(import.meta.dirname, "../..");
const revision =
  process.env.PAWKET_BROWSER_APP_REVISION ??
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
if (!/^[0-9a-f]{40}$/u.test(revision)) {
  throw new Error("PAWKET_BROWSER_APP_REVISION must be one exact lowercase source SHA");
}
const valkeyUrl = resolveIncrementThreeBrowserValkeyUrl(process.env);
const storageFixture = resolveIncrementThreeStorageFixture(process.env);
const publicMediaEnvironment = {
  ...incrementThreeStorageEnvironment(storageFixture),
  PUBLIC_MEDIA_MAX_UPLOAD_BYTES: "10485760",
  PUBLIC_MEDIA_ALLOWED_MIME_TYPES: "image/jpeg,image/png,image/webp",
  PUBLIC_MEDIA_CLEANUP_SCAN_INTERVAL_MS: "60000",
  PUBLIC_MEDIA_RETENTION_MODE: "report_only",
} as const;

export default defineConfig({
  ...base,
  globalSetup: "./tests/increment-three-global-setup.ts",
  outputDir: path.resolve(import.meta.dirname, ".playwright-artifacts", "increment-three-enabled"),
  testMatch: [...INCREMENT_THREE_ENABLED_TESTS],
  testIgnore: [],
  timeout: 120_000,
  use: {
    ...base.use,
    actionTimeout: 15_000,
    baseURL: "http://127.0.0.1:4175",
    extraHTTPHeaders: { "x-real-ip": "127.0.0.1" },
  },
  webServer: [
    {
      command: directBinaries
        ? "node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 4175"
        : "corepack pnpm --filter @pawket/web start --port 4175",
      url: "http://127.0.0.1:4175/creators",
      env: {
        ...(base.webServer && !Array.isArray(base.webServer) ? base.webServer.env : {}),
        DATABASE_URL: browserDatabaseUrl,
        VALKEY_URL: valkeyUrl,
        APP_REVISION: revision,
        APP_BUILD_REVISION: revision,
        APP_BASE_URL: "http://127.0.0.1:4175",
        AUTH_TRUSTED_ORIGINS: "http://127.0.0.1:4175",
        CREATOR_PUBLISHING_MODE: "general_audience",
        ...publicMediaEnvironment,
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: directBinaries ? "node dist/index.js" : "corepack pnpm --filter @pawket/worker start",
      cwd: directBinaries ? "../worker" : "../..",
      port: 9464,
      env: {
        ...(base.webServer && !Array.isArray(base.webServer) ? base.webServer.env : {}),
        DATABASE_URL: browserDatabaseUrl,
        VALKEY_URL: valkeyUrl,
        APP_REVISION: revision,
        APP_BUILD_REVISION: revision,
        APP_BASE_URL: "http://127.0.0.1:4175",
        AUTH_TRUSTED_ORIGINS: "http://127.0.0.1:4175",
        CREATOR_PUBLISHING_MODE: "general_audience",
        ...publicMediaEnvironment,
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
