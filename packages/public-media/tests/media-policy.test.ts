import { describe, expect, test } from "vitest";
import {
  CREATOR_SOURCE_ALLOCATION_BYTES,
  MAX_SOURCE_BYTES,
  MAX_SOURCE_PIXELS,
  MEDIA_VARIANTS,
  UPLOAD_INTENT_LIFETIME_MS,
  isOpaqueVersionId,
  sourceFormatForContentType,
} from "../src/media-policy.js";

describe("public media policy", () => {
  test("uses the approved bounded source and quota constants", () => {
    expect(MAX_SOURCE_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_SOURCE_PIXELS).toBe(40_000_000);
    expect(UPLOAD_INTENT_LIFETIME_MS).toBe(15 * 60_000);
    expect(CREATOR_SOURCE_ALLOCATION_BYTES).toBe(500 * 1024 * 1024);
    expect(MEDIA_VARIANTS).toEqual(["master", "thumb", "display", "large"]);
  });

  test("accepts only the three static image media types", () => {
    expect(sourceFormatForContentType("image/jpeg")).toBe("jpeg");
    expect(sourceFormatForContentType("image/png; charset=binary")).toBe("png");
    expect(sourceFormatForContentType("image/webp")).toBe("webp");
    expect(sourceFormatForContentType("image/gif")).toBeNull();
    expect(sourceFormatForContentType("image/svg+xml")).toBeNull();
  });

  test.each([
    ["version/with+opaque=_-~", true],
    ["/+=._~-", true],
    [" null ", false],
    ["NULL", false],
    ["version with space", false],
    ["version\nnewline", false],
    [`version${String.fromCharCode(0x85)}control`, false],
    ["x".repeat(512), true],
    ["x".repeat(513), false],
    [null, false],
  ])("validates provider version IDs (%s)", (value, expected) => {
    expect(isOpaqueVersionId(value)).toBe(expected);
  });
});
