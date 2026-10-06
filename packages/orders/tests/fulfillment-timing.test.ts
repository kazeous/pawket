import { describe, expect, test } from "vitest";
import { commissionCompletionDueAt, commissionFileDeletionAt, commissionReviewEndsAt } from "../src/index.js";

const due = new Date("2026-11-17T07:00:00Z");
const firstPause = { startedAt: new Date("2026-11-16T00:00:00Z"), endedAt: new Date("2026-11-18T00:00:00Z") };
const secondPause = { startedAt: new Date("2026-11-19T00:00:00Z"), endedAt: new Date("2026-11-21T00:00:00Z") };

describe("commission fulfillment timing", () => {
  test("review window ends exactly N days later", () => {
    expect(commissionReviewEndsAt(new Date("2026-11-10T07:00:00Z"), 7).toISOString()).toBe("2026-11-17T07:00:00.000Z");
  });
  test("no pauses returns reviewEndsAt", () => {
    expect(commissionCompletionDueAt(due, [])).toEqual(due);
  });
  test("a pause covering the deadline moves it to resume plus 48 hours", () => {
    expect(commissionCompletionDueAt(due, [firstPause])?.toISOString()).toBe("2026-11-20T00:00:00.000Z");
  });
  test("an open pause covering the deadline gives null", () => {
    expect(commissionCompletionDueAt(due, [{ ...firstPause, endedAt: null }])).toBeNull();
  });
  test("a pause that ended before the deadline changes nothing", () => {
    expect(commissionCompletionDueAt(due, [{ ...firstPause, endedAt: new Date("2026-11-17T06:59:59.999Z") }])).toEqual(due);
  });
  test("a pause ending exactly at the deadline changes nothing", () => {
    expect(commissionCompletionDueAt(due, [{ ...firstPause, endedAt: due }])).toEqual(due);
  });
  test("a pause starting exactly at the deadline covers it", () => {
    expect(commissionCompletionDueAt(due, [{ ...firstPause, startedAt: due }])?.toISOString()).toBe("2026-11-20T00:00:00.000Z");
  });
  test("a pause starting after the deadline changes nothing, even when open", () => {
    expect(commissionCompletionDueAt(due, [{ ...secondPause, endedAt: null }])).toEqual(due);
  });
  test("a second pause inside the grace chains in chronological order without mutating the pauses", () => {
    const pauses = Object.freeze([secondPause, firstPause]);
    expect(commissionCompletionDueAt(due, pauses)?.toISOString()).toBe("2026-11-23T00:00:00.000Z");
    expect(pauses[0]).toBe(secondPause); expect(due.toISOString()).toBe("2026-11-17T07:00:00.000Z");
  });
  test("an open second pause inside the grace gives null", () => {
    expect(commissionCompletionDueAt(due, [firstPause, { ...secondPause, endedAt: null }])).toBeNull();
  });
  test("file deletion is 180 days after completion", () => {
    const completedAt = new Date("2026-11-10T07:00:00Z");
    expect(commissionFileDeletionAt(completedAt).getTime() - completedAt.getTime()).toBe(180 * 86_400_000);
  });
});
