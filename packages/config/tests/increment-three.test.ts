import { describe, expect, test } from "vitest";
import { resolveIncrementThreeEnv } from "../src/increment-three.js";

describe("Increment 3 environment", () => {
  const enabledPublishingEnv = {
    CREATOR_PUBLISHING_MODE: "general_audience" as const,
    PUBLIC_MEDIA_S3_ENDPOINT: "https://media.example.com",
    PUBLIC_MEDIA_S3_REGION: "ap-southeast-1",
    PUBLIC_MEDIA_S3_ACCESS_KEY_ID: "media-access-key",
    PUBLIC_MEDIA_S3_SECRET_ACCESS_KEY: "media-secret-key",
    PUBLIC_MEDIA_QUARANTINE_BUCKET: "pawket-media-quarantine",
    PUBLIC_MEDIA_DERIVATIVE_BUCKET: "pawket-media-derivatives",
  };

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

  test("requires HTTPS for deployed publishing", () => {
    expect(() =>
      resolveIncrementThreeEnv(
        { ...enabledPublishingEnv, PUBLIC_MEDIA_S3_ENDPOINT: "http://media.example.com" },
        "production",
      ),
    ).toThrow(/PUBLIC_MEDIA_S3_ENDPOINT/);
  });

  test("requires both S3 credentials for deployed publishing", () => {
    expect(() => {
      const { PUBLIC_MEDIA_S3_SECRET_ACCESS_KEY: _secret, ...missingSecret } = enabledPublishingEnv;
      resolveIncrementThreeEnv(missingSecret, "production");
    }).toThrow(/PUBLIC_MEDIA_S3_SECRET_ACCESS_KEY/);
  });

  test("requires distinct S3 buckets for deployed publishing", () => {
    expect(() =>
      resolveIncrementThreeEnv(
        {
          ...enabledPublishingEnv,
          PUBLIC_MEDIA_DERIVATIVE_BUCKET: enabledPublishingEnv.PUBLIC_MEDIA_QUARANTINE_BUCKET,
        },
        "production",
      ),
    ).toThrow(/PUBLIC_MEDIA_DERIVATIVE_BUCKET/);
  });

  test("accepts DNS-safe S3 bucket labels for deployed publishing", () => {
    expect(resolveIncrementThreeEnv(enabledPublishingEnv, "production")).toMatchObject({
      PUBLIC_MEDIA_QUARANTINE_BUCKET: "pawket-media-quarantine",
      PUBLIC_MEDIA_DERIVATIVE_BUCKET: "pawket-media-derivatives",
    });
  });

  test.each(["abc.-def", "abc-.def"]) (
    "rejects a bucket label with a boundary hyphen: %s",
    (bucket) => {
      expect(() =>
        resolveIncrementThreeEnv(
          { ...enabledPublishingEnv, PUBLIC_MEDIA_QUARANTINE_BUCKET: bucket },
          "production",
        ),
      ).toThrow(/PUBLIC_MEDIA_QUARANTINE_BUCKET/);
    },
  );

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
