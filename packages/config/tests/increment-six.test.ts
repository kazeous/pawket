import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { incrementSixEnvShape, resolveIncrementSixEnv } from "../src/increment-six.js";
import { parseServerEnv } from "../src/index.js";

const base = { NODE_ENV: "test", APP_ENV: "test", APP_REVISION: "synthetic",
  DATABASE_URL: "postgresql://test:test@localhost:15449/test", VALKEY_URL: "redis://localhost:16389", METRICS_TOKEN: "synthetic-test-metrics-000000000000" };
const shape = z.object(incrementSixEnvShape);
const dependencies = { PII_ACTIVE_KEY_ID: "synthetic", PII_KEYRING_JSON: { synthetic: "synthetic-only" }, PII_LOOKUP_HMAC_KEY: "synthetic-only",
  AUTH_PRIMARY_STEP_UP_TTL_SECONDS: 3600, AUTH_OWNER_TOTP_STEP_UP_TTL_SECONDS: 3600 };

describe("commission operational controls", () => {
  test.each(["COMMISSION_RECENT_AUTH_SECONDS", "COMMISSION_TOTP_AUTH_SECONDS"] as const)("defaults and bounds %s at one hour", (field) => {
    expect(shape.parse({})[field]).toBe(3600);
    expect(shape.parse({ [field]: "3600" })[field]).toBe(3600);
    expect(() => shape.parse({ [field]: "3601" })).toThrow();
  });
  test("defaults disabled and keeps intake, payments, tip and publishing independent", () => {
    expect(parseServerEnv(base)).toMatchObject({ COMMISSION_INTAKE_MODE: "disabled", COMMISSION_PAYMENTS_MODE: "disabled" });
    for (const intake of ["disabled", "enabled"]) for (const payment of ["disabled", "manual_only", "sepay_optional"]) {
      expect(parseServerEnv({ ...base, COMMISSION_INTAKE_MODE: intake, COMMISSION_PAYMENTS_MODE: payment })).toMatchObject({
        COMMISSION_INTAKE_MODE: intake, COMMISSION_PAYMENTS_MODE: payment, TIP_PAYMENTS_MODE: "disabled", CREATOR_PUBLISHING_MODE: "disabled", SEPAY_INGRESS_MODE: "disabled",
      });
    }
  });
  test("intake requires encryption even while payment creation is paused", () => {
    expect(() => resolveIncrementSixEnv(shape.parse({ COMMISSION_INTAKE_MODE: "enabled" }))).toThrow("validated encryption keyring");
    const resolved = resolveIncrementSixEnv({ ...shape.parse({ COMMISSION_INTAKE_MODE: "enabled" }), ...dependencies });
    expect(resolved).not.toHaveProperty("PII_KEYRING_JSON"); expect(resolved).not.toHaveProperty("PII_LOOKUP_HMAC_KEY");
  });
  test("confirmation assurance cannot outlive Identity step-up", () => {
    const parsed = { ...shape.parse({ COMMISSION_PAYMENTS_MODE: "manual_only" }), ...dependencies };
    expect(() => resolveIncrementSixEnv({ ...parsed, AUTH_PRIMARY_STEP_UP_TTL_SECONDS: 60 })).toThrow("COMMISSION_RECENT_AUTH_SECONDS");
    expect(() => resolveIncrementSixEnv({ ...parsed, AUTH_OWNER_TOTP_STEP_UP_TTL_SECONDS: 30 })).toThrow("COMMISSION_TOTP_AUTH_SECONDS");
    expect(() => resolveIncrementSixEnv({ ...parsed, AUTH_PRIMARY_STEP_UP_TTL_SECONDS: 3599 })).toThrow("COMMISSION_RECENT_AUTH_SECONDS");
    expect(() => resolveIncrementSixEnv({ ...parsed, AUTH_OWNER_TOTP_STEP_UP_TTL_SECONDS: 3599 })).toThrow("COMMISSION_TOTP_AUTH_SECONDS");
  });
  test.each(["", "0", "501", "1e2", "1.0", " 100", "-1"])("rejects invalid scan bounds %j", (value) => {
    expect(() => parseServerEnv({ ...base, COMMISSION_SCAN_BATCH_SIZE: value })).toThrow("COMMISSION_SCAN_BATCH_SIZE");
  });
  test.each(["true", "manual", " enabled", ""])("rejects noncanonical mode %j", (value) => {
    expect(() => parseServerEnv({ ...base, COMMISSION_INTAKE_MODE: value })).toThrow("COMMISSION_INTAKE_MODE");
    expect(() => parseServerEnv({ ...base, COMMISSION_PAYMENTS_MODE: value })).toThrow("COMMISSION_PAYMENTS_MODE");
  });
  test("does not accept environment overrides of approved financial terms or retention", () => {
    const parsed = parseServerEnv({ ...base, COMMISSION_MINIMUM_VND: "1", COMMISSION_PAYMENT_TTL_SECONDS: "999999", COMMISSION_RETENTION_MODE: "enforce" });
    expect(parsed).not.toHaveProperty("COMMISSION_MINIMUM_VND"); expect(parsed).not.toHaveProperty("COMMISSION_PAYMENT_TTL_SECONDS"); expect(parsed).not.toHaveProperty("COMMISSION_RETENTION_MODE");
  });
  test("delivery surfaces keep both controls disabled", () => {
    const root = new URL("../../../", import.meta.url);
    for (const key of ["COMMISSION_INTAKE_MODE", "COMMISSION_PAYMENTS_MODE"]) {
      expect(readFileSync(new URL(".env.example", root), "utf8")).toContain(`${key}=disabled`);
      expect(readFileSync(new URL(".github/workflows/verify.yml", root), "utf8")).toContain(`${key}: disabled`);
      expect(readFileSync(new URL("compose.prod.yaml", root), "utf8").match(new RegExp(`^      ${key}: disabled$`, "gm"))).toHaveLength(2);
    }
  });
});
