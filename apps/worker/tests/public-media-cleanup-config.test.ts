import { describe, expect, test } from "vitest";

import { createWorkerPublicMediaConfiguration } from "../src/public-media-cleanup-config.js";

describe("worker public-media cleanup composition", () => {
  const env = {
    PUBLIC_MEDIA_PROCESSING_CONCURRENCY: 3,
    PUBLIC_MEDIA_CLEANUP_SCAN_INTERVAL_MS: 123_000,
    PUBLIC_MEDIA_RETENTION_MODE: "report_only" as const,
    RETENTION_MODE: "report_only" as const,
    RETENTION_ENFORCEMENT_PAUSED: true,
    RETENTION_BATCH_SIZE: 37,
  };

  test("always wires the report-only scan without fake storage, hold, or acceptance providers", () => {
    const result = createWorkerPublicMediaConfiguration(env);

    expect(result.publicMedia).toBeUndefined();
    expect(result.publicMediaCleanup).toEqual({
      mode: "report_only",
      retentionMode: "report_only",
      globalPause: true,
      batchSize: 37,
      scanIntervalMs: 123_000,
    });
    expect(result.publicMediaCleanup).not.toHaveProperty("storage");
    expect(result.publicMediaCleanup).not.toHaveProperty("holds");
    expect(result.publicMediaCleanup).not.toHaveProperty("acceptance");
  });

  test("reuses the real private storage boundary for processing and report-only cleanup", () => {
    const storage = { marker: "real-storage" } as never;
    const result = createWorkerPublicMediaConfiguration(env, storage);

    expect(result.publicMedia).toEqual({ storage, concurrency: 3 });
    expect(result.publicMediaCleanup).toEqual(expect.objectContaining({ storage, mode: "report_only" }));
  });

  test("refuses deletion activation before real Trust hold and acceptance adapters exist", () => {
    expect(() => createWorkerPublicMediaConfiguration({
      ...env,
      PUBLIC_MEDIA_RETENTION_MODE: "enforce",
      RETENTION_MODE: "enforce",
      RETENTION_ENFORCEMENT_PAUSED: false,
    })).toThrow("PUBLIC_MEDIA_CLEANUP_ENFORCEMENT_NOT_CONFIGURED");
  });
});
