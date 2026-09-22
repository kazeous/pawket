import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";
import { z } from "zod";

import { incrementFourEnvShape, resolveIncrementFourEnv } from "../src/increment-four.js";
import { parseServerEnv } from "../src/index.js";

const shape = z.object(incrementFourEnvShape);
const amountSettings = {
  TIP_AMOUNT_MIN_VND: "10000",
  TIP_AMOUNT_MAX_VND: "5000000",
  TIP_SUGGESTED_PRESETS_VND: "[20000,50000,100000]",
};
const localBase = {
  NODE_ENV: "test", APP_ENV: "test", APP_REVISION: "synthetic",
  DATABASE_URL: "postgresql://test:test@localhost:15438/test", VALKEY_URL: "redis://localhost:6379",
  METRICS_TOKEN: "synthetic-test-metrics-000000000000",
};

describe("Increment 4 fail-closed configuration", () => {
  test("keeps defaults and publishing/retention independent", () => {
    const parsed = parseServerEnv(localBase);
    expect(parsed).toMatchObject({
      TIP_PAYMENTS_MODE: "disabled",

      CREATOR_PUBLISHING_MODE: "disabled", PUBLIC_MEDIA_RETENTION_MODE: "report_only",
    });
    expect(parseServerEnv({ ...localBase, TIP_PAYMENTS_MODE: "manual_only" })).toMatchObject({
      TIP_PAYMENTS_MODE: "manual_only", CREATOR_PUBLISHING_MODE: "disabled", PUBLIC_MEDIA_RETENTION_MODE: "report_only",
    });
  });

  test.each(["true", "enabled", "sepay", "manual", "", " manual_only"])("rejects unknown mode %j", (mode) => {
    expect(() => parseServerEnv({ ...localBase, TIP_PAYMENTS_MODE: mode })).toThrow("TIP_PAYMENTS_MODE");
  });

  test.each(["production", "staging", "test"] as const)("does not require an env amount policy in %s", (environment) => {
    expect(resolveIncrementFourEnv(shape.parse({}), environment).TIP_PAYMENTS_MODE).toBe("disabled");
  });

  test.each(["", "malformed", "-1", "10000.0", "1e4", "[1,1]"])("ignores obsolete business amounts %j without relaxing operational validation", (value) => {
    const parsed = parseServerEnv({ ...localBase, TIP_AMOUNT_MIN_VND: value, TIP_AMOUNT_MAX_VND: value, TIP_SUGGESTED_PRESETS_VND: value });
    for (const field of Object.keys(amountSettings)) expect(parsed).not.toHaveProperty(field);
    expect(parsed.TIP_PAYMENTS_MODE).toBe("disabled");
    expect(() => parseServerEnv({ ...localBase, TIP_INTENT_TTL_SECONDS: "bad" })).toThrow("TIP_INTENT_TTL_SECONDS");
  });
  test("manual mode requires encryption and authentication dependencies", () => {
    const parsed = shape.parse({ ...amountSettings, TIP_PAYMENTS_MODE: "manual_only" });
    expect(() => resolveIncrementFourEnv(parsed, "test")).toThrow("validated encryption keyring");
    const dependencies = {
      PII_ACTIVE_KEY_ID: "test-key", PII_KEYRING_JSON: { "test-key": "test-only" }, PII_LOOKUP_HMAC_KEY: "test-only",
      AUTH_PRIMARY_STEP_UP_TTL_SECONDS: 900, AUTH_OWNER_TOTP_STEP_UP_TTL_SECONDS: 300,
    };
    expect(() => resolveIncrementFourEnv({ ...parsed, ...dependencies, AUTH_PRIMARY_STEP_UP_TTL_SECONDS: 60 }, "test")).toThrow("TIP_RECENT_AUTH_SECONDS");
    expect(() => resolveIncrementFourEnv({ ...parsed, ...dependencies, AUTH_OWNER_TOTP_STEP_UP_TTL_SECONDS: 30 }, "test")).toThrow("TIP_TOTP_AUTH_SECONDS");
    const resolved = resolveIncrementFourEnv({ ...parsed, ...dependencies }, "test");
    expect(resolved).not.toHaveProperty("PII_KEYRING_JSON");
    expect(resolved).not.toHaveProperty("PII_LOOKUP_HMAC_KEY");
  });

  test("bounds access lifetime, rates, batches and queues", () => {
    expect(() => resolveIncrementFourEnv(shape.parse({ TIP_GUEST_RECEIPT_TTL_SECONDS: "3600" }), "test")).toThrow("must cover the intent lifetime");
    for (const [field, value] of Object.entries({ TIP_QUEUE_PAGE_SIZE: "101", TIP_EXPIRY_BATCH_SIZE: "501", TIP_RATE_WINDOW_SECONDS: "0", TIP_CREATE_IP_LIMIT: "0", TIP_OPEN_IP_LIMIT: "21", TIP_INTENT_TTL_SECONDS: "604801" })) {
      expect(() => parseServerEnv({ ...localBase, [field]: value })).toThrow(field);
    }
  });

  test("ships identical disabled policy in example, CI and both deployed services", () => {
    const root = new URL("../../../", import.meta.url);
    const example = readFileSync(new URL(".env.example", root), "utf8");
    const ci = readFileSync(new URL(".github/workflows/verify.yml", root), "utf8");
    const compose = readFileSync(new URL("compose.prod.yaml", root), "utf8");
    expect(example).toContain("TIP_PAYMENTS_MODE=disabled");
    expect(ci).toContain("TIP_PAYMENTS_MODE: disabled");
    expect(compose.match(/^      TIP_PAYMENTS_MODE: disabled$/gm)).toHaveLength(2);
    for (const key of Object.keys(amountSettings)) {
      expect(example).not.toContain(key);
      expect(ci).not.toContain(key);
      expect(compose).not.toContain(key);
    }
  });
});
