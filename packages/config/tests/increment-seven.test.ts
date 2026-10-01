import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { incrementSevenEnvShape, resolveIncrementSevenEnv } from "../src/increment-seven.js";
import { parseServerEnv } from "../src/index.js";

const base = { NODE_ENV: "test", APP_ENV: "test", APP_REVISION: "synthetic",
  DATABASE_URL: "postgresql://test:test@localhost:15449/test", VALKEY_URL: "redis://localhost:16389", METRICS_TOKEN: "synthetic-test-metrics-000000000000" };
const shape = z.object(incrementSevenEnvShape);
const keys = { PII_ACTIVE_KEY_ID: "synthetic", PII_KEYRING_JSON: { synthetic: "synthetic-only" }, PII_LOOKUP_HMAC_KEY: "synthetic-only", APP_ENV: "test" as const };
const storage = { COMMISSION_FILES_S3_ENDPOINT: "http://127.0.0.1:9090", COMMISSION_FILES_S3_REGION: "us-east-1",
  COMMISSION_FILES_S3_ACCESS_KEY_ID: "synthetic-key", COMMISSION_FILES_S3_SECRET_ACCESS_KEY: "synthetic-secret",
  COMMISSION_FILES_QUARANTINE_BUCKET: "pawket-commission-quarantine", COMMISSION_FILES_CLEAN_BUCKET: "pawket-commission-clean" };

describe("commission file controls", () => {
  test("defaults off and report-only", () => {
    expect(parseServerEnv(base)).toMatchObject({ COMMISSION_FILES_MODE: "disabled", COMMISSION_FILE_RETENTION_MODE: "report_only",
      COMMISSION_FILES_CLAMD_PORT: 3310, COMMISSION_FILES_SCAN_CONCURRENCY: 1, COMMISSION_INTAKE_MODE: "disabled" });
  });
  test("enabling files requires the keyring, storage and distinct buckets", () => {
    expect(() => resolveIncrementSevenEnv({ ...shape.parse({ COMMISSION_FILES_MODE: "enabled", ...storage }), APP_ENV: "test" })).toThrow("validated encryption keyring");
    expect(() => resolveIncrementSevenEnv({ ...shape.parse({ COMMISSION_FILES_MODE: "enabled" }), ...keys })).toThrow("COMMISSION_FILES_S3_ENDPOINT");
    expect(() => resolveIncrementSevenEnv({ ...shape.parse({ COMMISSION_FILES_MODE: "enabled", ...storage, COMMISSION_FILES_CLEAN_BUCKET: "pawket-commission-quarantine" }), ...keys })).toThrow("COMMISSION_FILES_CLEAN_BUCKET");
    const resolved = resolveIncrementSevenEnv({ ...shape.parse({ COMMISSION_FILES_MODE: "enabled", ...storage }), ...keys });
    expect(resolved).toMatchObject({ COMMISSION_FILES_MODE: "enabled" });
    expect(resolved).not.toHaveProperty("PII_KEYRING_JSON");
  });
  test("production storage must use https", () => {
    expect(() => resolveIncrementSevenEnv({ ...shape.parse({ COMMISSION_FILES_MODE: "enabled", ...storage }), ...keys, APP_ENV: "production" })).toThrow("https");
  });
  test("retention enforcement needs an acceptance reference", () => {
    expect(() => resolveIncrementSevenEnv({ ...shape.parse({ COMMISSION_FILE_RETENTION_MODE: "enforce" }), APP_ENV: "test" })).toThrow("COMMISSION_FILE_RETENTION_ACCEPTANCE_REFERENCE");
    expect(resolveIncrementSevenEnv({ ...shape.parse({ COMMISSION_FILE_RETENTION_MODE: "enforce", COMMISSION_FILE_RETENTION_ACCEPTANCE_REFERENCE: "owner-2026-11-01" }), APP_ENV: "test" }))
      .toMatchObject({ COMMISSION_FILE_RETENTION_MODE: "enforce" });
  });
  test.each(["true", " enabled", "", "on"])("rejects noncanonical mode %j", (value) => {
    expect(() => parseServerEnv({ ...base, COMMISSION_FILES_MODE: value })).toThrow("COMMISSION_FILES_MODE");
  });
  test.each(["0", "3", "1.0", " 1"])("bounds scan concurrency %j", (value) => {
    expect(() => parseServerEnv({ ...base, COMMISSION_FILES_SCAN_CONCURRENCY: value })).toThrow("COMMISSION_FILES_SCAN_CONCURRENCY");
  });
  test("rejects a clamd host with a scheme or path", () => {
    expect(() => parseServerEnv({ ...base, COMMISSION_FILES_CLAMD_HOST: "tcp://clamd" })).toThrow("COMMISSION_FILES_CLAMD_HOST");
    expect(parseServerEnv({ ...base, COMMISSION_FILES_CLAMD_HOST: "clamd" })).toMatchObject({ COMMISSION_FILES_CLAMD_HOST: "clamd" });
  });
  test("delivery surfaces keep files disabled and retention report-only", () => {
    const root = new URL("../../../", import.meta.url);
    const read = (path: string) => readFileSync(new URL(path, root), "utf8");
    expect(read(".env.example")).toContain("COMMISSION_FILES_MODE=disabled");
    expect(read(".env.example")).toContain("COMMISSION_FILE_RETENTION_MODE=report_only");
    expect(read(".github/workflows/verify.yml")).toContain("COMMISSION_FILES_MODE: disabled");
    expect(read("compose.prod.yaml").match(/^      COMMISSION_FILES_MODE: disabled$/gmu)).toHaveLength(2);
    expect(read("compose.prod.yaml").match(/^      COMMISSION_FILE_RETENTION_MODE: report_only$/gmu)).toHaveLength(2);
  });
});
