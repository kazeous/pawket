import path from "node:path";
import { defineConfig } from "@playwright/test";
import base from "./playwright.increment-four.config";

export default defineConfig({ ...base, testMatch: ["auth-sso.playwright.ts"],
  outputDir: path.resolve(import.meta.dirname, ".playwright-artifacts", "auth-sso") });
