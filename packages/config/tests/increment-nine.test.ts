import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { parseServerEnv } from "../src/index.js";
import { incrementNineEnvShape, IncrementNineConfigError, resolveIncrementNineEnv } from "../src/increment-nine.js";

const base = { NODE_ENV: "test", APP_ENV: "test", APP_REVISION: "synthetic",
  DATABASE_URL: "postgresql://test:test@localhost:15449/test", VALKEY_URL: "redis://localhost:16389", METRICS_TOKEN: "synthetic-test-metrics-000000000000" };
const storage = { COMMISSION_FILES_MODE: "enabled", COMMISSION_FILES_S3_ENDPOINT: "http://127.0.0.1:9090", COMMISSION_FILES_S3_REGION: "us-east-1",
  COMMISSION_FILES_S3_ACCESS_KEY_ID: "synthetic-key", COMMISSION_FILES_S3_SECRET_ACCESS_KEY: "synthetic-secret",
  COMMISSION_FILES_QUARANTINE_BUCKET: "pawket-commission-quarantine", COMMISSION_FILES_CLEAN_BUCKET: "pawket-commission-clean",
  COMMISSION_FULFILLMENT_MODE: "enabled", COMMISSION_RESOLUTION_MODE: "enabled" };
const shape = z.object(incrementNineEnvShape);

describe("notification controls", () => {
  test("NOTIFICATIONS_MODE defaults to disabled", () => {
    expect(shape.parse({})).toEqual({ NOTIFICATIONS_MODE: "disabled" });
    expect(parseServerEnv(base).NOTIFICATIONS_MODE).toBe("disabled");
    expect(resolveIncrementNineEnv({ ...shape.parse({}), COMMISSION_PAYMENTS_MODE: "disabled" })).toEqual({ NOTIFICATIONS_MODE: "disabled" });
  });
  test.each(["true", " enabled", "", "on", "DISABLED"])("rejects values other than disabled and enabled: %j", (value) => {
    expect(() => shape.parse({ NOTIFICATIONS_MODE: value })).toThrow();
    expect(() => parseServerEnv({ ...base, NOTIFICATIONS_MODE: value })).toThrow("NOTIFICATIONS_MODE");
  });
  test.each(["manual_only", "sepay_optional"] as const)("refuses commission payments without notifications: %s", (payments) => {
    const failure = { field: "COMMISSION_PAYMENTS_MODE", reason: "requires NOTIFICATIONS_MODE=enabled" };
    const resolve = () => resolveIncrementNineEnv({ NOTIFICATIONS_MODE: "disabled", COMMISSION_PAYMENTS_MODE: payments });
    expect(resolve).toThrow(IncrementNineConfigError);
    expect(resolve).toThrow(expect.objectContaining({ failures: [failure] }));
    expect(() => parseServerEnv({ ...base, ...storage, COMMISSION_PAYMENTS_MODE: payments, NOTIFICATIONS_MODE: "disabled" }))
      .toThrow(`${failure.field} ${failure.reason}`);
  });
  test.each(["disabled", "manual_only", "sepay_optional"] as const)("allows commission payments with notifications enabled: %s", (payments) => {
    expect(resolveIncrementNineEnv({ NOTIFICATIONS_MODE: "enabled", COMMISSION_PAYMENTS_MODE: payments })).toEqual({ NOTIFICATIONS_MODE: "enabled" });
    expect(parseServerEnv({ ...base, ...storage, COMMISSION_PAYMENTS_MODE: payments, NOTIFICATIONS_MODE: "enabled" }))
      .toMatchObject({ COMMISSION_PAYMENTS_MODE: payments, NOTIFICATIONS_MODE: "enabled" });
  });
  test("delivery surfaces keep notifications disabled", () => {
    const root = new URL("../../../", import.meta.url);
    expect(readFileSync(new URL(".env.example", root), "utf8")).toContain("NOTIFICATIONS_MODE=disabled");
    expect(readFileSync(new URL(".github/workflows/verify.yml", root), "utf8")).toMatch(/^  NOTIFICATIONS_MODE: disabled$/mu);
    const compose = readFileSync(new URL("compose.prod.yaml", root), "utf8");
    for (const name of ["web", "worker"]) {
      const service = compose.split(`\n  ${name}:`)[1]!.split(/\n  [a-z][a-z-]*:/u)[0]!;
      expect(service).toMatch(/^      NOTIFICATIONS_MODE: disabled$/mu);
    }
  });
});
