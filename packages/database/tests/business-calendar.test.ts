import { describe, expect, test } from "vitest";

import {
  calculateBusinessDayWindow,
  vietnamDateFromInstant,
} from "../src/index.js";

describe("Vietnam business calendar", () => {
  test("calculates immutable day-five/day-seven dates across a holiday and weekends", () => {
    const holidays = ["2026-09-02"];
    const window = calculateBusinessDayWindow({
      receiptDate: "2026-08-28",
      calendarVersion: "vn-2026-v1",
      holidays,
    });

    expect(window).toEqual({
      receiptDate: "2026-08-28",
      calendarVersion: "vn-2026-v1",
      refundNotBefore: "2026-09-07",
      refundDue: "2026-09-09",
    });
    expect(holidays).toEqual(["2026-09-02"]);
  });

  test("derives the stored receipt date at the Asia/Ho_Chi_Minh boundary", () => {
    expect(vietnamDateFromInstant(new Date("2026-08-24T16:59:59.999Z"))).toBe("2026-08-24");
    expect(vietnamDateFromInstant(new Date("2026-08-24T17:00:00.000Z"))).toBe("2026-08-25");
  });

  test("rejects impossible date-only input", () => {
    expect(() =>
      calculateBusinessDayWindow({
        receiptDate: "2026-02-30",
        calendarVersion: "vn-2026-v1",
        holidays: [],
      }),
    ).toThrow("Business calendar is invalid");
  });
});
