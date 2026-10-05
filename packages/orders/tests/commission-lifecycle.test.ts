import { describe, expect, test } from "vitest";
import { CommissionError, commissionPlainText, commissionText, requireCommissionTransition } from "../src/index.js";

describe("commission fulfillment lifecycle", () => {
  test.each([
    ["in_progress", "delivered"], ["in_progress", "in_progress"],
    ["delivered", "in_progress"], ["delivered", "completed"],
  ] as const)("allows %s to %s", (from, to) => {
    expect(() => requireCommissionTransition(from, to)).not.toThrow();
  });
  test.each([
    ["completed", "in_progress"], ["in_progress", "completed"],
    ["delivered", "delivered"], ["delivered", "closed"],
  ] as const)("refuses %s to %s", (from, to) => {
    expect(() => requireCommissionTransition(from, to)).toThrow(new CommissionError("invalid_transition"));
  });
  test("allows angle brackets in plain text while preserving the brief rule", () => {
    expect(commissionPlainText("<3", 1, 10) === "<3").toBe(true);
    expect(commissionPlainText("a < b", 1, 10) === "a < b").toBe(true);
    expect(() => commissionText("<3", 1, 10)).toThrow(new CommissionError("invalid_request"));
  });
  test("plain text refuses bidi overrides", () => {
    expect(() => commissionPlainText("a\u202eb", 1, 10)).toThrow(new CommissionError("invalid_request"));
  });
  test("plain text shares normalization and Unicode code point bounds", () => {
    expect(commissionPlainText("  e\u0301\r\nx  ", 1, 10) === "é\nx").toBe(true);
    expect(commissionPlainText("🎨".repeat(2_000), 0, 2_000).length).toBe(4_000);
    expect(commissionPlainText("   ", 0, 2_000).length).toBe(0);
    for (const value of ["🎨".repeat(2_001), "\ud800", "a\u0000b", " ", null]) {
      expect(() => commissionPlainText(value, 1, 2_000)).toThrow(new CommissionError("invalid_request"));
    }
  });
});
