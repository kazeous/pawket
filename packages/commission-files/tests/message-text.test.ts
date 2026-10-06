import { describe, expect, test } from "vitest";
import { normalizeCommissionMessageText } from "../src/index.js";

describe("commission message text", () => {
  test("whitespace-only text becomes null", () => {
    expect(normalizeCommissionMessageText("   \n  ")).toBeNull();
  });
  test("absent text becomes null for attachment-only messages", () => {
    expect(normalizeCommissionMessageText(undefined)).toBeNull();
    expect(normalizeCommissionMessageText(null)).toBeNull();
  });
  test("4000 emoji code points are accepted", () => {
    expect(normalizeCommissionMessageText("🎨".repeat(4000))).toBe("🎨".repeat(4000));
  });
  test("4001 emoji code points are refused", () => {
    expect(() => normalizeCommissionMessageText("🎨".repeat(4001))).toThrow("invalid_request");
  });
  test("angle brackets are preserved literally", () => {
    expect(normalizeCommissionMessageText("<3 a < b")).toBe("<3 a < b");
  });
  test("normalizes NFC, line endings and outer whitespace", () => {
    expect(normalizeCommissionMessageText(" e\u0301\r\nx\ry \n")).toBe("é\nx\ny");
    expect(normalizeCommissionMessageText("x\r\ny")).toBe("x\ny");
  });
  test.each([0x0000, 0x0008, 0x000b, 0x000c, 0x000e, 0x001f, 0x007f, 0x061c, 0x200e, 0x200f,
    0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069])("refuses forbidden control code point %i", (point) => {
    expect(() => normalizeCommissionMessageText("a" + String.fromCodePoint(point) + "b")).toThrow("invalid_request");
  });
  test("refuses lone surrogates", () => {
    expect(() => normalizeCommissionMessageText("\ud800")).toThrow("invalid_request");
    expect(() => normalizeCommissionMessageText("\udfff")).toThrow("invalid_request");
  });
  test("forbidden whitespace controls cannot disappear through trimming", () => {
    expect(() => normalizeCommissionMessageText("\u000b")).toThrow("invalid_request");
    expect(() => normalizeCommissionMessageText("\u000ctext")).toThrow("invalid_request");
  });
  test("accepts escaped whitespace within the code point and JSON byte limits", () => {
    expect(normalizeCommissionMessageText("🎨\n".repeat(2000))).toHaveLength(5999);
    expect(normalizeCommissionMessageText("\t".repeat(4000))).toBeNull();
    expect(normalizeCommissionMessageText("a" + "\t".repeat(3998) + "b")).toHaveLength(4000);
  });
  test("refuses non-string values without coercion", () => {
    for (const value of [false, 12, {}, [], { toString: () => "coerced" }]) {
      expect(() => normalizeCommissionMessageText(value)).toThrow("invalid_request");
    }
  });
});
