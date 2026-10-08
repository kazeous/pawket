// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../src/ui/cases/case-client", async (original) => ({ ...await original<object>(), caseRequest: request }));
import { CaseQueue } from "../src/ui/cases/case-queue";
import { CaseDetail } from "../src/ui/cases/case-detail";
import { RulingForm, rulingBounds } from "../src/ui/cases/ruling-form";
import { RefundCaseActions } from "../src/ui/cases/refund-case-actions";
import type { CaseDetailView } from "../src/ui/cases/case-client";

const id = "10000000-0000-4000-8000-000000000001";
const at = "2026-10-08T00:00:00.000Z";
const detail: CaseDetailView = { caseId: id, orderId: id, sourceId: id, sourceType: "commission_dispute", kind: "dispute", state: "open",
  resolutionKind: null, policyRevisionId: id, version: 1, openedAt: at, resolvedAt: null, creatorStanding: "active", creatorUserId: "synthetic-creator",
  buyerUserId: "synthetic-buyer", orderState: "in_progress", amountVnd: 500_000, disputeOpenedAt: at, respondBy: at, nextDeadline: at, ruling: null,
  events: [{ id, action: "opened", reason: null, beforeState: null, afterState: "open", occurredAt: at, resultingVersion: 1 }],
  accessLog: [{ id, itemType: "thread_page", itemId: id, ownerUserId: "synthetic-owner", ownerSessionId: "synthetic-session", accessedAt: at }] };
const markup = (element: Parameters<typeof renderToStaticMarkup>[0]) => { const node = document.createElement("div"); node.innerHTML = renderToStaticMarkup(element); return node; };
afterEach(() => { request.mockReset(); vi.unstubAllGlobals(); });
async function mounted(element: Parameters<typeof renderToStaticMarkup>[0], run: (node: HTMLDivElement) => Promise<void>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); const node = document.createElement("div"); document.body.append(node); const root = createRoot(node);
  try { await act(async () => root.render(element)); await run(node); } finally { await act(async () => root.unmount()); node.remove(); }
}
test("queue shows kind, age, next deadline and metadata filters", () => {
  const node = markup(createElement(CaseQueue, { initialCases: [{ ...detail, nextDeadline: at }], now: new Date("2026-10-10T00:00:00Z") }));
  expect(node.textContent).toContain("Khiếu nại đơn hàng"); expect(node.textContent).toContain("2 ngày"); expect(node.querySelector("time")?.dateTime).toBe(at);
  expect(node.querySelector('a[href="/admin/cases/' + id + '"]')).not.toBeNull();
  for (const label of ["Loại vụ việc", "Tuổi vụ việc", "Hạn tiếp theo"]) expect(node.textContent).toContain(label);
});
test.each(["active", "suspended"] as const)("loading real case event fields keeps evidence and %s creator actions available", async (creatorStanding) => {
  // TrustCaseService serializes the database's beforeState/afterState fields.
  const response = { ...detail, creatorStanding, events: [{ id, action: "opened", reason: null, beforeState: null, afterState: "open", occurredAt: at, resultingVersion: 1 }] };
  request.mockImplementation(async (path: string) => path.endsWith("/evidence") ? { evidence: { brief: { text: "Synthetic private evidence" } } } : { case: response });
  vi.useFakeTimers();
  try {
    await mounted(createElement(CaseDetail, { caseId: id, actorUserId: "synthetic-owner" }), async (node) => {
      await act(async () => { await vi.advanceTimersByTimeAsync(5); });
      const buttons = (label: string) => Array.from(node.querySelectorAll("button")).filter((button) => button.textContent === label);
      expect(buttons("Xem bằng chứng")).toHaveLength(1); expect(buttons("Xem bằng chứng")[0]!.disabled).toBe(false);
      expect(node.textContent?.includes("Chưa mở được vụ việc")).toBe(false);
      expect(node.textContent?.includes("Synthetic private evidence")).toBe(false);
      expect(request.mock.calls.map(([path]) => path)).toEqual([`/api/v1/admin/cases/${id}`]);
      expect(node.querySelector('[name="reasoning"]')).not.toBeNull();
      const freeze = node.querySelector<HTMLTextAreaElement>('[name="freezeReason"]');
      expect(freeze !== null).toBe(creatorStanding === "suspended");
      if (freeze) { expect(freeze.disabled).toBe(false); expect(freeze.labels?.[0]?.textContent?.startsWith("Lý do")).toBe(true); }
      await act(async () => buttons("Xem bằng chứng")[0]!.click());
      expect(buttons("Ẩn bằng chứng")).toHaveLength(1);
      expect(node.textContent?.includes("Synthetic private evidence")).toBe(true);
      expect(request.mock.calls.map(([path]) => path)).toEqual([`/api/v1/admin/cases/${id}`, `/api/v1/admin/cases/${id}/evidence`, `/api/v1/admin/cases/${id}`]);
      await act(async () => buttons("Lịch sử vụ việc")[0]!.click());
      expect(node.querySelector("ol")?.textContent).toContain("Mở vụ việc");
    });
  } finally { vi.useRealTimers(); }
});

test("evidence is fetched only after an explicit opening; closing and reopening logs a fresh view", async () => {
  request.mockImplementation(async (path: string) => path.endsWith("/evidence") ? { evidence: { brief: { text: "Synthetic private evidence" } } } : { case: detail });
  await mounted(createElement(CaseDetail, { initial: detail, caseId: id, actorUserId: "synthetic-owner" }), async (node) => {
    expect(request).not.toHaveBeenCalled(); expect(node.textContent?.includes("Synthetic private evidence")).toBe(false);
    const open = () => Array.from(node.querySelectorAll("button")).find((button) => button.textContent === "Xem bằng chứng")!;
    await act(async () => open().click());
    expect(request).toHaveBeenCalledWith(`/api/v1/admin/cases/${id}/evidence`, expect.objectContaining({ method: "POST", body: JSON.stringify({ section: "order_summary" }) }));
    expect(node.textContent?.includes("Synthetic private evidence")).toBe(true);
    await act(async () => Array.from(node.querySelectorAll("button")).find((button) => button.textContent === "Ẩn bằng chứng")!.click());
    expect(node.textContent?.includes("Synthetic private evidence")).toBe(false);
    await act(async () => open().click()); expect(request.mock.calls.filter(([path]) => path.endsWith("/evidence"))).toHaveLength(2);
  });
});
test("resolved detail has no evidence open controls and lists access entries", () => {
  const node = markup(createElement(CaseDetail, { initial: { ...detail, state: "resolved" }, caseId: id, actorUserId: "synthetic-owner" }));
  expect(node.textContent).not.toContain("Xem bằng chứng"); expect(node.textContent).toContain("Nhật ký truy cập");
});
test("access log tab lists item, time and owner session", async () => {
  await mounted(createElement(CaseDetail, { initial: detail, caseId: id, actorUserId: "synthetic-owner" }), async (node) => {
    await act(async () => Array.from(node.querySelectorAll("button")).find((button) => button.textContent === "Nhật ký truy cập")!.click());
    expect(node.textContent).toContain("Tin nhắn và bàn giao"); expect(node.textContent).toContain("synthetic-session"); expect(request).not.toHaveBeenCalled();
  });
});
test("ruling has four choices, delivered-only completion, required reasoning and owner-only note", () => {
  const node = markup(createElement(RulingForm, { orderState: "in_progress", amountVnd: 500_000, disabled: false, onSubmit: vi.fn() }));
  const options = node.querySelectorAll<HTMLOptionElement>('[name="outcome"] option'); expect(options).toHaveLength(4);
  expect(options[0]!.disabled && options[1]!.disabled).toBe(true); expect(options[2]!.disabled || options[3]!.disabled).toBe(false);
  expect(node.querySelector<HTMLTextAreaElement>('[name="reasoning"]')!.required).toBe(true);
  expect(node.textContent).toContain("Ghi chú nội bộ (chỉ owner thấy)");
  expect(rulingBounds("complete_none", 500_000)).toEqual({ min: 0, max: 0 });
  expect(rulingBounds("complete_partial", 500_000)).toEqual({ min: 1, max: 499_999 });
  expect(rulingBounds("close_full", 500_000)).toEqual({ min: 500_000, max: 500_000 });
  expect(rulingBounds("close_partial", 500_000)).toEqual({ min: 0, max: 499_999 });
});
test("ruling rejects out-of-bounds amounts and code-point text limits before sending", async () => {
  const send = vi.fn();
  await mounted(createElement(RulingForm, { orderState: "delivered", amountVnd: 500_000, disabled: false, onSubmit: send }), async (node) => {
    const select = node.querySelector<HTMLSelectElement>('[name="outcome"]')!;
    await act(async () => { select.value = "complete_partial"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    const input = node.querySelector<HTMLInputElement>('[name="amount"]')!;
    expect(input.min).toBe("1"); expect(input.max).toBe("499999"); input.value = "500000";
    node.querySelector<HTMLTextAreaElement>('[name="reasoning"]')!.value = "Synthetic reason";
    await act(async () => { node.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); expect(send).not.toHaveBeenCalled();
    input.value = "100000"; node.querySelector<HTMLTextAreaElement>('[name="internalNote"]')!.value = "x".repeat(2001);
    await act(async () => { node.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); expect(send).not.toHaveBeenCalled();
    node.querySelector<HTMLTextAreaElement>('[name="internalNote"]')!.value = "";
    await act(async () => { node.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(send).toHaveBeenCalledWith({ action: "rule", outcome: "complete", refundAmountVnd: 100_000, reasoning: "Synthetic reason" });
  });
});
test.each(["refund_not_received", "refund_overdue"] as const)("refund actions match %s", (kind) => {
  const node = markup(createElement(RefundCaseActions, { kind, disabled: false, onSubmit: vi.fn() }));
  expect(node.textContent).toContain("Miễn nghĩa vụ hoàn tiền");
  expect(node.textContent?.includes("Chấp nhận bằng chứng đã nhận tiền")).toBe(kind === "refund_not_received");
  expect(node.textContent?.includes("Yêu cầu chuyển lại")).toBe(kind === "refund_not_received");
  expect(node.textContent?.includes("Gia hạn chuyển hoàn tiền")).toBe(kind === "refund_overdue");
});
test.each(["active", "suspended", "none"] as const)("freeze follows standing %s and requires a reason", (creatorStanding) => {
  const node = markup(createElement(CaseDetail, { initial: { ...detail, creatorStanding }, caseId: id, actorUserId: "synthetic-owner" }));
  expect(node.textContent?.includes("Đóng băng thực hiện đơn")).toBe(creatorStanding === "suspended");
  if (creatorStanding === "suspended") expect(node.querySelector<HTMLTextAreaElement>('[name="freezeReason"]')?.required).toBe(true);
});
test("freeze needs acknowledgement and posts the server-derived creator identifier", async () => {
  const suspended = { ...detail, creatorStanding: "suspended" as const }; request.mockResolvedValue({ case: suspended });
  await mounted(createElement(CaseDetail, { initial: suspended, caseId: id, actorUserId: "synthetic-owner" }), async (node) => {
    const form = node.querySelector<HTMLTextAreaElement>('[name="freezeReason"]')!.closest("form")!;
    form.querySelector<HTMLTextAreaElement>('[name="freezeReason"]')!.value = "Synthetic reason";
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); expect(request).not.toHaveBeenCalled();
    form.querySelector<HTMLInputElement>('[name="acknowledge"]')!.checked = true;
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(request.mock.calls[0]?.[0]).toBe("/api/v1/admin/creators/synthetic-creator/freeze");
    expect(request.mock.calls[0]?.[1]?.body === JSON.stringify({ reason: "Synthetic reason" })).toBe(true);
  });
});
test("refund extension rejects deadlines more than 30 days ahead", async () => {
  const send = vi.fn();
  await mounted(createElement(RefundCaseActions, { kind: "refund_overdue", disabled: false, now: new Date(at), onSubmit: send }), async (node) => {
    node.querySelector<HTMLTextAreaElement>('[name="reason"]')!.value = "Synthetic reason";
    node.querySelector<HTMLInputElement>('[name="until"]')!.value = "2027-01-01T00:00";
    await act(async () => { node.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); expect(send).not.toHaveBeenCalled();
    node.querySelector<HTMLInputElement>('[name="until"]')!.value = "2026-10-10T00:00";
    await act(async () => { node.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); expect(send).toHaveBeenCalledOnce();
  });
});
test("aging tab loads on demand and lists only order, amount and age", async () => {
  request.mockResolvedValue({ refunds: [{ orderId: id, amountVnd: 100_000, ageDays: 31, buyerUserId: "do-not-display" }] });
  await mounted(createElement(CaseQueue, { initialCases: [] }), async (node) => {
    expect(request).not.toHaveBeenCalled();
    await act(async () => Array.from(node.querySelectorAll("button")).find((button) => button.textContent === "Hoàn tiền chờ tài khoản")!.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    expect(request.mock.calls[0]![0]).toBe("/api/v1/admin/refunds/aging"); expect(node.textContent).toContain("31 ngày");
    expect(node.textContent?.includes("do-not-display")).toBe(false);
  });
});
