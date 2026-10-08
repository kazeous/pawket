import { describe, expect, test } from "vitest";
import { normalizeResolutionText, RESOLUTION_POLICY } from "../src/policy.js";

describe("resolution text policy", () => {
  test("accepts 4,000 emoji and refuses 4,001", () => {
    expect([...normalizeResolutionText("😀".repeat(4_000), 1, 4_000)]).toHaveLength(4_000);
    expect(() => normalizeResolutionText("😀".repeat(4_001), 1, 4_000)).toThrow("invalid_request");
  });
  test("refuses U+202E", () => {
    expect(() => normalizeResolutionText("synthetic\u202e", 1, 4_000)).toThrow("invalid_request");
  });
  test("keeps line breaks", () => {
    expect(normalizeResolutionText(" e\u0301\r\nsecond\rthird ", 1, 4_000)).toBe("é\nsecond\nthird");
  });
  test.each(["\t", "\u0000", "\u007f", "\ud800", "\u2066"])("refuses forbidden character %s", (character) => {
    expect(() => normalizeResolutionText(`synthetic${character}`, 1, 4_000)).toThrow("invalid_request");
  });
  test("uses the approved pause grace", () => { expect(RESOLUTION_POLICY.pauseGraceMs).toBe(172_800_000); });
  test("uses the approved 30-day refund extension cap", () => { expect(RESOLUTION_POLICY.maxRefundExtensionMs).toBe(2_592_000_000); });
});
