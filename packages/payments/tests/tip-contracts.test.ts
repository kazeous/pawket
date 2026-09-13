import { describe, expect, test } from "vitest";

import { requireIntegerVnd, TipPaymentError } from "../src/tip-contracts.js";

describe("integer VND domain boundary", () => {
  const policy = { minimumVnd: 10_000, maximumVnd: 5_000_000 };
  test.each([10_000, 20_000, 50_000, 100_000, 5_000_000])("accepts exact approved VND %s", (amount) => {
    expect(requireIntegerVnd(amount, policy)).toBe(amount);
  });
  test.each([0, -1, 9_999, 5_000_001, 10_000.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "20000", "20,000", null, true, {}, []])("rejects invalid domain amount %j", (amount) => {
    expect(() => requireIntegerVnd(amount, policy)).toThrow(TipPaymentError);
    expect(() => requireIntegerVnd(amount, policy)).toThrow("invalid_amount");
  });
  test("rejects invalid policy instead of disabling validation", () => {
    for (const bounds of [ { minimumVnd: NaN, maximumVnd: 50_000 }, { minimumVnd: 50_000, maximumVnd: 10_000 }, { minimumVnd: 0, maximumVnd: 50_000 } ]) {
      expect(() => requireIntegerVnd(20_000, bounds)).toThrow("invalid_amount");
    }
  });
});
