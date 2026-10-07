import { describe, expect, test } from "vitest";

import {
  calculateBusinessDayWindow,
  addVietnamBusinessDays,
  calculateStoredBusinessDayDeadline,
  type PawketTransaction,
  vietnamDateFromInstant,
} from "../src/index.js";

describe("Vietnam business calendar", () => {
  test("five business days from Friday 2026-10-09 skips the weekend", () => {
    expect(addVietnamBusinessDays({ fromDate: "2026-10-09", businessDays: 5, holidays: [] })).toBe("2026-10-16");
  });
  test("holidays are skipped", () => {
    expect(addVietnamBusinessDays({ fromDate: "2026-10-09", businessDays: 5, holidays: ["2026-10-12"] })).toBe("2026-10-19");
  });
  test("calculateStoredBusinessDayDeadline returns 16:59:59.999Z of that Vietnam date", async () => {
    const tx = { select: () => ({ from: () => ({ where: () => ({
      limit: async () => [{ version: "vn-2026-v1" }],
      then: (resolve: (rows: { date: string }[]) => unknown) => resolve([]),
    }) }) }) } as unknown as PawketTransaction;
    expect((await calculateStoredBusinessDayDeadline(tx, { from: new Date("2026-10-09T04:00:00Z"), businessDays: 5,
      calendarVersion: "vn-2026-v1" })).toISOString()).toBe("2026-10-16T16:59:59.999Z");
  });
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
