import { describe, expect, test } from "vitest";
import { resolveIncrementThreeEnv } from "../src/increment-three.js";

describe("Increment 3 environment", () => {
  test("defaults publishing and media deletion to disabled/report-only", () => {
    expect(resolveIncrementThreeEnv({}, "local")).toMatchObject({
      CREATOR_PUBLISHING_MODE: "disabled",
      PUBLIC_MEDIA_RETENTION_MODE: "report_only",
      PUBLIC_MEDIA_PROCESSING_CONCURRENCY: 2,
    });
  });

  test("requires complete private S3 configuration when publishing is enabled", () => {
    expect(() =>
      resolveIncrementThreeEnv({ CREATOR_PUBLISHING_MODE: "general_audience" }, "production"),
    ).toThrow(/PUBLIC_MEDIA_S3_ENDPOINT/);
  });

  test("rejects media enforce while global retention is paused", () => {
    expect(() =>
      resolveIncrementThreeEnv(
        {
          PUBLIC_MEDIA_RETENTION_MODE: "enforce",
          RETENTION_MODE: "enforce",
          RETENTION_ENFORCEMENT_PAUSED: true,
          PUBLIC_MEDIA_RETENTION_ACCEPTANCE_REFERENCE: "approval-2026-08-29",
        },
        "production",
      ),
    ).toThrow(/PUBLIC_MEDIA_RETENTION_MODE/);
  });
});
