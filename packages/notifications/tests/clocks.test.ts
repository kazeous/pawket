import { describe, expect, test } from "vitest";
import { CLOCK_CATEGORIES, reminderStage } from "../src/clocks.js";
import { NOTIFICATION_CLOCKS, NOTIFICATION_POLICY } from "../src/policy.js";

const at = (iso: string) => new Date(iso);

describe("reminder stage", () => {
  test("due_24h fires inside the last 24 hours", () => {
    const startedAt = at("2026-11-01T00:00:00Z"); const effectiveDeadline = at("2026-11-05T00:00:00Z");
    const stage = (now: string) => reminderStage({ now: at(now), startedAt, effectiveDeadline, missedBy: "domain" });
    expect(stage("2026-11-03T23:59:59.999Z")).toBeNull();
    expect(stage("2026-11-04T00:00:00Z")).toBe("due_24h");
    expect(stage("2026-11-04T23:59:59.999Z")).toBe("due_24h");
    // At the deadline a domain clock has nothing more to send.
    expect(stage("2026-11-05T00:00:00Z")).toBeNull();
    expect(NOTIFICATION_POLICY.reminderLeadMs).toBe(24 * 3_600_000);
  });

  test("skipped when the clock started less than 36 hours before the deadline", () => {
    expect(reminderStage({ now: at("2026-11-01T12:00:00Z"), startedAt: at("2026-11-01T00:00:00Z"), effectiveDeadline: at("2026-11-02T10:00:00Z"), missedBy: "scan" })).toBeNull();
    // Exactly 36 hours of notice is enough.
    expect(reminderStage({ now: at("2026-11-01T12:00:00Z"), startedAt: at("2026-11-01T00:00:00Z"), effectiveDeadline: at("2026-11-02T12:00:00Z"), missedBy: "scan" })).toBe("due_24h");
    expect(NOTIFICATION_POLICY.reminderMinimumNoticeMs).toBe(36 * 3_600_000);
  });

  test("missed only for scan clocks", () => {
    const input = { now: at("2026-11-06T00:00:00Z"), startedAt: at("2026-11-01T00:00:00Z"), effectiveDeadline: at("2026-11-05T00:00:00Z") };
    expect(reminderStage({ ...input, missedBy: "scan" })).toBe("missed");
    expect(reminderStage({ ...input, now: input.effectiveDeadline, missedBy: "scan" })).toBe("missed");
    expect(reminderStage({ ...input, missedBy: "domain" })).toBeNull();
    expect(reminderStage({ ...input, missedBy: "none" })).toBeNull();
    // A short clock is still announced as missed; the 36-hour rule only skips the advance reminder.
    expect(reminderStage({ ...input, startedAt: at("2026-11-04T12:00:00Z"), missedBy: "scan" })).toBe("missed");
  });

  test("null deadline gives null", () => {
    for (const missedBy of ["scan", "domain", "none"] as const) {
      expect(reminderStage({ now: at("2026-11-06T00:00:00Z"), startedAt: at("2026-11-01T00:00:00Z"), effectiveDeadline: null, missedBy })).toBeNull();
    }
  });

  test("every clock has a category", () => {
    expect(Object.keys(CLOCK_CATEGORIES).sort()).toEqual([...NOTIFICATION_CLOCKS].sort());
    expect(CLOCK_CATEGORIES).toMatchObject({ request_response: "orders", quote_acceptance: "orders", payment: "orders", delivery_due: "orders",
      review_window: "orders", proposal_response: "disputes_refunds", dispute_response: "disputes_refunds", late_claim_response: "disputes_refunds",
      refund_send: "disputes_refunds", refund_confirm: "disputes_refunds", appeal_window: "moderation" });
  });
});
