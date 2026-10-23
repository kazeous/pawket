import { describe, expect, test } from "vitest";
import {
  NOTIFICATION_CATEGORIES, NOTIFICATION_KINDS, caseLink, isNotificationLinkPath, orderLink, renderNotice, subjectForCategory,
  type NoticeDraft,
} from "../src/index.js";

const orderId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const caseId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

describe("notification catalog", () => {
  test("every kind renders a title, body and action label", () => {
    for (const kind of NOTIFICATION_KINDS) {
      const notice = renderNotice(kind, null);
      for (const line of [notice.title, notice.body, notice.actionLabel]) {
        expect(line.trim().length, kind).toBeGreaterThan(0);
        expect(line, kind).not.toMatch(/[\r\n]/u);
      }
      expect(notice.title.length, kind).toBeLessThanOrEqual(80);
      expect(notice.actionLabel.length, kind).toBeLessThanOrEqual(40);
    }
  });

  test("link helpers produce the documented paths", () => {
    expect(orderLink("creator", orderId)).toBe(`/creator/commissions/${orderId}`);
    expect(orderLink("buyer", orderId)).toBe(`/commissions/${orderId}`);
    expect(caseLink(caseId)).toBe(`/admin/cases/${caseId}`);
    for (const path of [orderLink("creator", orderId), orderLink("buyer", orderId), caseLink(caseId)]) {
      expect(isNotificationLinkPath(path)).toBe(true);
    }
    expect(() => orderLink("buyer", "../x")).toThrow();
    expect(() => caseLink("not-a-uuid")).toThrow();
  });

  test("isNotificationLinkPath accepts the seven allowed shapes", () => {
    for (const path of ["/help/cases", "/creator/tips", "/creator/apply", "/creator", `/commissions/${orderId}`,
      `/creator/commissions/${orderId}`, `/admin/cases/${caseId}`]) expect(isNotificationLinkPath(path), path).toBe(true);
  });

  test("isNotificationLinkPath refuses //host, https:, backslashes, query strings and paths outside the allowlist", () => {
    for (const path of ["//evil.example/creator", "https://pawket.example/creator", "https:/creator", "\\creator", "/creator\\tips",
      "/creator?next=1", "/creator/tips?x=1", "/creator#frag", "/creator/", "/creator//tips", "creator", "", "/", "/admin",
      "/admin/cases", `/admin/cases/${orderId}/x`, "/commissions", "/commissions/not-a-uuid", `/commissions/${orderId}/`,
      `/orders/${orderId}`, "/settings/notifications", "/help/locked", "/help/cases/extra", "/CREATOR", " /creator", "/creator ",
      "/creator\n", `/creator/commissions/${orderId}%2e`]) expect(isNotificationLinkPath(path), JSON.stringify(path)).toBe(false);
    expect(isNotificationLinkPath(undefined as never)).toBe(false);
    expect(isNotificationLinkPath(7 as never)).toBe(false);
  });

  test("category subjects are fixed Vietnamese strings", () => {
    expect(subjectForCategory("orders")).toBe("Cập nhật đơn đặt vẽ trên Pawket");
    expect(subjectForCategory("messages")).toBe("Tin nhắn mới trên Pawket");
    expect(subjectForCategory("deliveries")).toBe("Cập nhật bản nháp trên Pawket");
    expect(subjectForCategory("disputes_refunds")).toBe("Cập nhật khiếu nại hoặc hoàn tiền trên Pawket");
    expect(subjectForCategory("moderation")).toBe("Thông báo kiểm duyệt Pawket");
    expect(subjectForCategory("owner_queue")).toBe("Có việc mới trong hàng chờ Pawket");
    expect(subjectForCategory("tips")).toBe("Cập nhật tip Pawket");
    // Account notices are in-app only; no notification email exists for them.
    expect(() => subjectForCategory("account")).toThrow();
    expect(NOTIFICATION_CATEGORIES).toContain("account");
  });

  test("unknown variants fall back to the kind text and never throw", () => {
    expect(renderNotice("order_closed", "no_such_reason")).toEqual(renderNotice("order_closed", null));
  });

  test("a NoticeDraft is a plain readonly value", () => {
    const draft: NoticeDraft = { recipientUserId: "u1", kind: "order_requested", variant: null, category: "orders", actionRequired: true,
      subjectType: "commission_order", subjectId: orderId, linkPath: orderLink("creator", orderId), email: "now" };
    expect(draft.email).toBe("now");
  });
});
