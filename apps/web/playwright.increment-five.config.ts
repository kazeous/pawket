import path from "node:path";
import { defineConfig } from "@playwright/test";
import base from "./playwright.increment-four.config";

// Uses the existing guarded, disposable creator/owner fixture database. Run the
// I4 and I5 browser suites sequentially; neither selects a production fake provider.
export default defineConfig({
  ...base, testMatch: ["sepay-journey.playwright.ts"],
  outputDir: path.resolve(import.meta.dirname, ".playwright-artifacts", "increment-five"),
  webServer: (Array.isArray(base.webServer) ? base.webServer : []).map((server, index) => ({ ...server,
    env: { ...server.env, TIP_PAYMENTS_MODE: index === 0 ? "sepay_optional" : "disabled", SEPAY_INGRESS_MODE: "disabled", SEPAY_ENVIRONMENT: "test",
      VALKEY_URL: process.env.TEST_VALKEY_URL ?? "redis://127.0.0.1:16379/0" },
  })),
});
