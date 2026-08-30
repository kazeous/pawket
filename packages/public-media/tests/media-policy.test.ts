import { describe, expect, test } from "vitest";
import {
  CREATOR_SOURCE_ALLOCATION_BYTES,
  MAX_SOURCE_BYTES,
  MAX_SOURCE_PIXELS,
  MEDIA_VARIANTS,
  UPLOAD_INTENT_LIFETIME_MS,
  isOpaqueVersionId,
  isRawStorageEtag,
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
    expect(sourceFormatForContentType("image/png")).toBe("png");
    expect(sourceFormatForContentType("image/webp")).toBe("webp");
    expect(sourceFormatForContentType(" image/png ")).toBeNull();
    expect(sourceFormatForContentType("IMAGE/PNG")).toBeNull();
    expect(sourceFormatForContentType("image/png; charset=binary")).toBeNull();
    expect(sourceFormatForContentType("image/gif")).toBeNull();
    expect(sourceFormatForContentType("image/svg+xml")).toBeNull();
  });

  test.each([
    ["version/with+opaque=_-~", true],
    ["/+=._~-", true],
    ["opaque:percent%@bang!(parentheses)-作品", true],
    [" null ", false],
    ["NULL", false],
    ["version with space", false],
    [`version${String.fromCharCode(0xa0)}space`, false],
    ["version\nnewline", false],
    [`version${String.fromCharCode(0x85)}control`, false],
    [`version${String.fromCharCode(0x202e)}bidi`, false],
    [`version${String.fromCharCode(0xfdd0)}noncharacter`, false],
    [`version${String.fromCharCode(0xfeff)}bom`, false],
    ["🎨".repeat(512), true],
    ["🎨".repeat(513), false],
    [null, false],
  ])("validates provider version IDs (%s)", (value, expected) => {
    expect(isOpaqueVersionId(value)).toBe(expected);
  });

  test.each([
    ['"etag:opaque%作品🎨"', true],
    ["etag with space", false],
    ["NULL", false],
    [`etag${String.fromCodePoint(0x202e)}bidi`, false],
    ["🎨".repeat(512), true],
    ["🎨".repeat(513), false],
  ])("validates persisted storage ETags with the shared opaque marker policy (%s)", (value, expected) => {
    expect(isRawStorageEtag(value)).toBe(expected);
  });
});
