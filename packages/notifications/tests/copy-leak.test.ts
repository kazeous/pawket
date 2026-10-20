import { describe, expect, test } from "vitest";
import { NOTIFICATION_CLOCKS, NOTIFICATION_KINDS, renderNotice } from "../src/index.js";

// The same markers are used by apps/worker/tests/notification-email-leak.test.ts for the rendered email.
const MARKERS = ["MARKER-MESSAGE-BODY", "MARKER-FILE.png", "9704229999999999", "MARKER-REPORTER", "MARKER-OWNER-REASON", "MARKER-DISPLAY-NAME"] as const;
const closeReasons = ["buyer_withdrawn", "creator_declined", "quote_withdrawn", "quote_declined", "request_expired", "quote_expired",
  "buyer_cancelled", "creator_cancelled", "payment_expired", "security_invalidated", "eligibility_invalidated", "cancelled_by_agreement",
  "cancelled_by_ruling", "buyer_cancelled_after_suspension", "fulfillment_frozen"];
const variants: readonly (string | null)[] = [null, ...NOTIFICATION_CLOCKS, ...closeReasons, "created", "confirmed", "expired",
  "dispute", "refund_not_received", "refund_overdue", "late_payment", "report", "appeal", "warning", "restriction", "suspension", "removal",
  "creator", "buyer"];

describe("notice copy never carries private content", () => {
  test("rendered notices contain no marker, long number, currency, address or link", () => {
    for (const kind of NOTIFICATION_KINDS) for (const variant of variants) {
      const { title, body, actionLabel } = renderNotice(kind, variant);
      for (const line of [title, body, actionLabel]) {
        for (const marker of MARKERS) expect(line).not.toContain(marker);
        expect(line, `${kind}/${variant}`).not.toMatch(/\d{3,}|₫|VND|@|https?:/iu);
      }
    }
  });

  test("markers passed as variant or kind are never echoed", () => {
    for (const marker of MARKERS) {
      for (const kind of NOTIFICATION_KINDS) {
        const { title, body, actionLabel } = renderNotice(kind, marker);
        expect(`${title} ${body} ${actionLabel}`).not.toContain(marker);
        expect({ title, body, actionLabel }).toEqual(renderNotice(kind, null));
      }
      expect(() => renderNotice(marker as never, null)).toThrow();
    }
    for (const unsafe of ["constructor", "__proto__", "toString"]) {
      expect(() => renderNotice(unsafe as never, null)).toThrow();
      expect(renderNotice("order_closed", unsafe)).toEqual(renderNotice("order_closed", null));
    }
  });

  test("notices that are not appealable never mention an appeal", () => {
    const warning = renderNotice("penalty_applied", "warning");
    expect(`${warning.title} ${warning.body} ${warning.actionLabel}`).not.toMatch(/kháng nghị/iu);
    expect(warning.actionLabel).toBe("Xem thông báo");
    for (const kind of ["content_restored", "penalty_ended"] as const) for (const variant of variants) {
      const { title, body, actionLabel } = renderNotice(kind, variant);
      expect(`${title} ${body} ${actionLabel}`, `${kind}/${variant}`).not.toMatch(/kháng nghị/iu);
    }
    for (const variant of ["restriction", "suspension", "removal"]) {
      expect(renderNotice("penalty_applied", variant).body).toMatch(/kháng nghị/iu);
    }
  });

  test("moderation notices use no blame wording", () => {
    for (const kind of ["content_hidden", "content_restored", "penalty_applied", "penalty_ended", "appeal_received", "appeal_decided", "report_received", "report_closed"] as const) {
      for (const variant of variants) {
        const { title, body } = renderNotice(kind, variant);
        expect(`${title} ${body}`, `${kind}/${variant}`).not.toMatch(/vi phạm|lỗi của bạn|bạn đã sai|cáo buộc/iu);
      }
    }
  });
});
