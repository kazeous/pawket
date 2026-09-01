import { defineConfig } from "@playwright/test";

import base from "./playwright.config";
import { prepareIncrementThreeDatabase } from "./tests/increment-three-database";

await prepareIncrementThreeDatabase();

const directBinaries = process.env.PAWKET_DIRECT_BROWSER_BINARIES === "1";

export default defineConfig({
  ...base,
  globalSetup: "./tests/increment-three-global-setup.ts",
  testMatch: [
    "creator-page-management.playwright.ts",
    "public-creator-discovery.playwright.ts",
    "public-content-reporting.playwright.ts",
  ],
  testIgnore: [],
  timeout: 120_000,
  use: {
    ...base.use,
    baseURL: "http://127.0.0.1:4175",
    extraHTTPHeaders: { "x-real-ip": "127.0.0.1" },
  },
  webServer: [
    {
      command: directBinaries
        ? "node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 4175"
        : "pnpm --filter @pawket/web start --port 4175",
      url: "http://127.0.0.1:4175/creators",
      env: {
      ...(base.webServer && !Array.isArray(base.webServer) ? base.webServer.env : {}),
      DATABASE_URL: "postgresql://pawket:pawket_dev_only@127.0.0.1:5432/pawket_task15_browser",
      APP_BASE_URL: "http://127.0.0.1:4175",
      AUTH_TRUSTED_ORIGINS: "http://127.0.0.1:4175",
      CREATOR_PUBLISHING_MODE: "general_audience",
      PUBLIC_MEDIA_S3_ENDPOINT: "http://127.0.0.1:9090",
      PUBLIC_MEDIA_S3_REGION: "us-east-1",
      PUBLIC_MEDIA_S3_ACCESS_KEY_ID: "local-media-access-key",
      PUBLIC_MEDIA_S3_SECRET_ACCESS_KEY: "local-media-secret-key",
      PUBLIC_MEDIA_QUARANTINE_BUCKET: "pawket-media-quarantine",
      PUBLIC_MEDIA_DERIVATIVE_BUCKET: "pawket-media-derivatives",
      PUBLIC_MEDIA_S3_FORCE_PATH_STYLE: "true",
      PUBLIC_MEDIA_MAX_UPLOAD_BYTES: "10485760",
      PUBLIC_MEDIA_ALLOWED_MIME_TYPES: "image/jpeg,image/png,image/webp",
    },
    reuseExistingServer: false,
    timeout: 120_000,
    },
    {
      command: directBinaries ? "node dist/index.js" : "pnpm --filter @pawket/worker start",
      cwd: directBinaries ? "../worker" : "../..",
      port: 9464,
      env: {
        ...(base.webServer && !Array.isArray(base.webServer) ? base.webServer.env : {}),
        DATABASE_URL: "postgresql://pawket:pawket_dev_only@127.0.0.1:5432/pawket_task15_browser",
        APP_BASE_URL: "http://127.0.0.1:4175",
        AUTH_TRUSTED_ORIGINS: "http://127.0.0.1:4175",
        CREATOR_PUBLISHING_MODE: "general_audience",
        PUBLIC_MEDIA_S3_ENDPOINT: "http://127.0.0.1:9090",
        PUBLIC_MEDIA_S3_REGION: "us-east-1",
        PUBLIC_MEDIA_S3_ACCESS_KEY_ID: "local-media-access-key",
        PUBLIC_MEDIA_S3_SECRET_ACCESS_KEY: "local-media-secret-key",
        PUBLIC_MEDIA_QUARANTINE_BUCKET: "pawket-media-quarantine",
        PUBLIC_MEDIA_DERIVATIVE_BUCKET: "pawket-media-derivatives",
        PUBLIC_MEDIA_S3_FORCE_PATH_STYLE: "true",
        PUBLIC_MEDIA_MAX_UPLOAD_BYTES: "10485760",
        PUBLIC_MEDIA_ALLOWED_MIME_TYPES: "image/jpeg,image/png,image/webp",
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
