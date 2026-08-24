import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.playwright.ts",
  timeout: 30_000,
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
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
