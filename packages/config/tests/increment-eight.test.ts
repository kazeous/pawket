import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { parseServerEnv } from "../src/index.js";

const base = { NODE_ENV: "test", APP_ENV: "test", APP_REVISION: "synthetic",
  DATABASE_URL: "postgresql://test:test@localhost:15449/test", VALKEY_URL: "redis://localhost:16389", METRICS_TOKEN: "synthetic-test-metrics-000000000000" };
const storage = { COMMISSION_FILES_MODE: "enabled", COMMISSION_FILES_S3_ENDPOINT: "http://127.0.0.1:9090", COMMISSION_FILES_S3_REGION: "us-east-1",
  COMMISSION_FILES_S3_ACCESS_KEY_ID: "synthetic-key", COMMISSION_FILES_S3_SECRET_ACCESS_KEY: "synthetic-secret",
  COMMISSION_FILES_QUARANTINE_BUCKET: "pawket-commission-quarantine", COMMISSION_FILES_CLEAN_BUCKET: "pawket-commission-clean" };

describe("commission resolution controls", () => {
  test("resolution defaults to disabled", () => {
    expect(parseServerEnv(base).COMMISSION_RESOLUTION_MODE).toBe("disabled");
  });
  test("resolution requires fulfilment", async () => {
    const failure = { field: "COMMISSION_RESOLUTION_MODE", reason: "requires COMMISSION_FULFILLMENT_MODE=enabled" };
    expect(() => parseServerEnv({ ...base, COMMISSION_RESOLUTION_MODE: "enabled", COMMISSION_FULFILLMENT_MODE: "disabled" }))
      .toThrow(`${failure.field} ${failure.reason}`);
    const { incrementEightEnvShape, IncrementEightConfigError, resolveIncrementEightEnv } = await import("../src/increment-eight.js");
    const resolve = () => resolveIncrementEightEnv({ ...z.object(incrementEightEnvShape).parse({ COMMISSION_RESOLUTION_MODE: "enabled" }),
      COMMISSION_FULFILLMENT_MODE: "disabled", COMMISSION_PAYMENTS_MODE: "disabled" });
    expect(resolve).toThrow(IncrementEightConfigError);
    expect(resolve).toThrow(expect.objectContaining({ failures: [failure] }));
  });
  test("commission payments require fulfilment and resolution", async () => {
    const failure = { field: "COMMISSION_PAYMENTS_MODE", reason: "requires COMMISSION_FULFILLMENT_MODE=enabled and COMMISSION_RESOLUTION_MODE=enabled" };
    expect(() => parseServerEnv({ ...base, ...storage, COMMISSION_PAYMENTS_MODE: "manual_only",
      COMMISSION_FULFILLMENT_MODE: "enabled", COMMISSION_RESOLUTION_MODE: "disabled" })).toThrow(`${failure.field} ${failure.reason}`);
    const { incrementEightEnvShape, IncrementEightConfigError, resolveIncrementEightEnv } = await import("../src/increment-eight.js");
    for (const payments of ["manual_only", "sepay_optional"] as const) {
      for (const [fulfillment, resolution] of [["enabled", "disabled"], ["disabled", "disabled"], ["disabled", "enabled"]] as const) {
        expect(() => parseServerEnv({ ...base, ...storage, COMMISSION_PAYMENTS_MODE: payments,
          COMMISSION_FULFILLMENT_MODE: fulfillment, COMMISSION_RESOLUTION_MODE: resolution })).toThrow(`${failure.field} ${failure.reason}`);
        const resolve = () => resolveIncrementEightEnv({ ...z.object(incrementEightEnvShape).parse({ COMMISSION_RESOLUTION_MODE: resolution }),
          COMMISSION_FULFILLMENT_MODE: fulfillment, COMMISSION_PAYMENTS_MODE: payments });
        expect(resolve).toThrow(IncrementEightConfigError);
        expect(resolve).toThrow(expect.objectContaining({ failures: expect.arrayContaining([failure]) }));
      }
      expect(parseServerEnv({ ...base, ...storage, COMMISSION_PAYMENTS_MODE: payments,
        COMMISSION_FULFILLMENT_MODE: "enabled", COMMISSION_RESOLUTION_MODE: "enabled" })).toMatchObject({ COMMISSION_PAYMENTS_MODE: payments, COMMISSION_RESOLUTION_MODE: "enabled" });
    }
  });
  test.each(["true", " enabled", "", "on"])("rejects noncanonical resolution mode %j", (value) => {
    expect(() => parseServerEnv({ ...base, COMMISSION_RESOLUTION_MODE: value })).toThrow("COMMISSION_RESOLUTION_MODE");
  });
  test("delivery surfaces keep resolution disabled", () => {
    const root = new URL("../../../", import.meta.url);
    expect(readFileSync(new URL(".env.example", root), "utf8").includes("COMMISSION_RESOLUTION_MODE=disabled")).toBe(true);
    expect(readFileSync(new URL(".github/workflows/verify.yml", root), "utf8").includes("COMMISSION_RESOLUTION_MODE: disabled")).toBe(true);
  });
});
