// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../src/ui/commissions/commission-session", () => ({ useCommissionSession: () => async () => "synthetic-actor",
  useCommissionCommand: () => ({ execute, retry: vi.fn(), locked: false, pending: false, code: null }), CommandFeedback: () => null }));
vi.mock("../src/platform/runtime", () => ({ getPlatformRuntime: vi.fn() }));
import { OrderResolutionPanel } from "../src/ui/resolutions/order-resolution-panel";
import { DisputeForm, disputeInputSchema } from "../src/ui/resolutions/dispute-panel";
import { RefundPanel, SendForm } from "../src/ui/resolutions/refund-panel";
import { MyCases } from "../src/ui/help/my-cases";
import { HelpPolicy } from "../src/ui/help/help-policy";
import { DisputePanel } from "../src/ui/resolutions/dispute-panel";
import { AttachedFileList } from "../src/ui/commissions/reference-files";
import { resolutionSchema, type ResolutionView, type RefundView } from "../src/ui/resolutions/resolution-client";
import { formatVnd } from "../src/ui/tips/tip-client";
import type { OrderView } from "../src/ui/commissions/commission-client";
import { fixtureRefund, resolutionFormLabels } from "./resolution-fixture-data";

const id = "10000000-0000-4000-8000-000000000001";
const order = { id, role: "buyer", state: "in_progress", version: 1, confirmedAt: "2026-10-08T00:00:00.000Z",
  terms: { amountVnd: 500_000 }, payment: null } as OrderView["order"];
const initial: ResolutionView = resolutionSchema.parse({ resolution: { role: "buyer", proposals: { pending: null, history: [] }, dispute: null,
  refunds: [], lateClaim: null, actions: { canPropose: false, canOpenDispute: false, disputeTrigger: null, disputeTriggerEndsAt: null, canCancelAfterSuspension: false } }, controls: { mode: "enabled" } });
const render = (view: ResolutionView, current = order) => renderToStaticMarkup(createElement(OrderResolutionPanel, { order: current, initial: view, onRefresh: async () => undefined }));
function labelledFields(markup: string, fields: Readonly<Record<string, string>>) {
  const container = document.createElement("div"); container.innerHTML = markup;
  for (const [selector, name] of Object.entries(fields)) {
    const control = container.querySelector(selector); expect(control, selector).not.toBeNull();
    const labels = Array.from(container.querySelectorAll("label")).filter((label) => label.control === control);
    expect(labels, selector).toHaveLength(1);
    expect(labels[0]!.textContent?.replace(/\s+/gu, " ").trim(), selector).toBe(name);
  }
}
test.each([false, true])("dispute action follows canOpenDispute=%s", (canOpenDispute) => {
  const markup = render({ ...initial, resolution: { ...initial.resolution, actions: { ...initial.resolution.actions, canOpenDispute } } });
  expect(markup.includes("Mở khiếu nại")).toBe(canOpenDispute);
});
test("staff review acknowledgement is required by the form and submitted data", () => {
  const markup = renderToStaticMarkup(createElement(DisputeForm, { order, disabled: false, onSubmit: vi.fn() }));
  expect(markup).toContain("Khi mở khiếu nại, Pawket sẽ xem tin nhắn và tệp riêng tư của đơn này để xem xét.");
  expect(markup).toMatch(/type="submit"[^>]*disabled|disabled[^>]*type="submit"/u);
  const payload = { expectedVersion: 1, reason: "not_delivered", statement: "Synthetic", requestedOutcome: { kind: "close", refundAmountVnd: 500_000 } };
  expect(disputeInputSchema.safeParse({ ...payload, acknowledgeStaffReview: false }).success).toBe(false);
  expect(disputeInputSchema.safeParse({ ...payload, acknowledgeStaffReview: true }).success).toBe(true);
});

test("dispute fields have accessible labels matching the browser locators", () => {
  labelledFields(renderToStaticMarkup(createElement(DisputeForm, { order, disabled: false, onSubmit: vi.fn() })), {
    '[name="reason"]': "Lý do", '[name="statement"]': resolutionFormLabels.statement, '[name="outcome"]': "Kết quả mong muốn",
    // Base UI derives the visible checkbox's name from its labelled native input on hydration.
    '[name="amount"]': "Số tiền muốn hoàn (VND) bắt buộc", 'input[type="checkbox"]': resolutionFormLabels.staffReview,
  });
});

test("refund send fields have accessible labels matching the browser locators", () => {
  labelledFields(renderToStaticMarkup(createElement(SendForm, { order: { ...order, role: "creator" }, createdAt: fixtureRefund.createdAt, disabled: false, onSubmit: vi.fn() })), {
    '[name="date"]': resolutionFormLabels.transferDate, '[name="reference"]': resolutionFormLabels.bankReference,
    '[name="note"]': "Ghi chú (không bắt buộc)", '[type="file"]': "Ảnh biên lai (không bắt buộc)",
  });
});

test("refund destination fields have accessible labels", () => {
  labelledFields(renderToStaticMarkup(createElement(RefundPanel, { order, refund: fixtureRefund, banks: { "970436": "Synthetic bank" }, disabled: false, onRefresh: async () => undefined })), {
    '[name="bank"]': "Ngân hàng bắt buộc", '[name="account"]': "Số tài khoản bắt buộc", '[name="holder"]': "Tên chủ tài khoản bắt buộc",
  });
});
test("refund bank starts on an empty disabled placeholder even when a destination exists", () => {
  const container = document.createElement("div"); container.innerHTML = renderToStaticMarkup(createElement(RefundPanel,
    { order, refund: fixtureRefund, banks: { "970415": "Synthetic bank A", "970436": "Synthetic bank B" }, disabled: false, onRefresh: async () => undefined }));
  const bank = container.querySelector<HTMLSelectElement>('[name="bank"]')!;
  expect(bank.value === "").toBe(true);
  expect(bank.options[0]!.value === "" && bank.options[0]!.disabled && bank.options[0]!.selected).toBe(true);
  expect(Array.from(bank.options).some((option) => option.value !== "" && option.selected)).toBe(false);
});
test("refund destination rejects an unchosen bank with an associated field error and accepts a selected bank", async () => {
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  execute.mockClear(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  try {
    await act(async () => root.render(createElement(RefundPanel,
      { order, refund: fixtureRefund, banks: { "970436": "Synthetic bank" }, disabled: false, onRefresh: async () => undefined })));
    const form = container.querySelector("form")!; const bank = form.querySelector<HTMLSelectElement>('[name="bank"]')!;
    form.querySelector<HTMLInputElement>('[name="account"]')!.value = "000000000001";
    form.querySelector<HTMLInputElement>('[name="holder"]')!.value = "SYNTHETIC BUYER";
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(execute.mock.calls.length).toBe(0);
    expect(bank.getAttribute("aria-invalid")).toBe("true");
    const error = document.getElementById(bank.getAttribute("aria-describedby")!);
    expect(error?.textContent?.trim()).toBe("Chọn ngân hàng nhận hoàn tiền.");
    bank.value = "970436";
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(execute.mock.calls.length).toBe(1);
    expect(execute.mock.calls[0]?.[1]?.bankBin === "970436").toBe(true);
    expect(bank.hasAttribute("aria-invalid")).toBe(false);
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});
test("creator refund view renders only masked details before reveal", () => {
  const refund = { obligationId: id, source: "agreement", sourceId: id, amountVnd: 100_000, reference: "PKR000000000000", state: "awaiting_send", version: 1,
    bankBin: "970436", bankName: "Synthetic bank", suffix: "4321", dueAt: "2026-10-15T00:00:00.000Z", confirmBy: null, endedAt: null,
    destinationPurgedAt: null, currentSendId: null, hasRecordedSend: false, createdAt: "2026-10-08T00:00:00.000Z", sends: [], accountNumber: "000000004321" } as RefundView;
  const markup = renderToStaticMarkup(createElement(RefundPanel, { order: { ...order, role: "creator" }, refund, disabled: false, onRefresh: async () => undefined }));
  expect(markup.includes("000000004321")).toBe(false);
  expect(markup).toContain("Xem thông tin chuyển hoàn tiền");
  expect(markup).not.toContain("Ghi nhận đã chuyển");
});
test("buyer sees the D7 file notice after a paid close", () => {
  expect(render(initial, { ...order, state: "closed" })).toContain("Đơn đã hủy nên bạn không còn tải được tệp của nghệ sĩ. Pawket không thể thu hồi các bản bạn đã tải về.");
  expect(render(initial, { ...order, state: "closed", confirmedAt: null })).not.toContain("Pawket không thể thu hồi");
});

test("presumed receipt describes an expired confirmation window without repeating receipt wording", () => {
  const refund = { ...fixtureRefund, state: "presumed_received" as const, hasRecordedSend: true };
  const markup = renderToStaticMarkup(createElement(RefundPanel, { order, refund, disabled: false, onRefresh: async () => undefined }));
  expect(markup).toContain("Hết hạn xác nhận hoàn tiền");
  expect(markup).not.toContain("xác nhận nhận tiền");
});
test.each([false, true])("suspension cancel follows canCancelAfterSuspension=%s", (canCancelAfterSuspension) => {
  expect(render({ ...initial, resolution: { ...initial.resolution, actions: { ...initial.resolution.actions, canCancelAfterSuspension } } }).includes("Hủy đơn và yêu cầu hoàn tiền toàn bộ")).toBe(canCancelAfterSuspension);
});
test.each(["final_delivery", "proposal_declined"] as const)("deadline markup uses the %s boundary consistently", (disputeTrigger) => {
  const markup = render({ ...initial, resolution: { ...initial.resolution, actions: { ...initial.resolution.actions, canOpenDispute: true, disputeTrigger, disputeTriggerEndsAt: "2026-10-08T00:00:00.000Z" } } });
  expect(markup).toContain("Mở khiếu nại trước");
  expect(markup).toContain(disputeTrigger === "final_delivery" ? 'dateTime="2026-10-08T00:00:00.000Z"' : 'dateTime="2026-10-08T00:00:00.001Z"');
});
test("my cases use each order's party route and omit owner case reasons", () => {
  const caseRow = { id, orderId: id, state: "open", reason: "not_delivered", trigger: "overdue", openedAt: "2026-10-08T00:00:00.000Z", closedAt: null, ownerCaseReason: "private-owner-reason" };
  const markup = renderToStaticMarkup(createElement(MyCases, { cases: { disputes: [caseRow], refunds: [], lateClaims: [] }, orderRoles: { [id]: "creator" } }));
  expect(markup).toContain(`/creator/commissions/${id}`); expect(markup.includes(caseRow.ownerCaseReason)).toBe(false);
});
test("help renders the current reviewed policy and an unpublished state", () => {
  const policy = { revisionId: id, revisionNumber: 2, document: "Synthetic <policy>", checksum: "synthetic", acceptsOrders: true };
  const markup = renderToStaticMarkup(createElement(HelpPolicy, { policy }));
  expect(markup).toContain("Phiên bản 2"); expect(markup).toContain("Synthetic &lt;policy&gt;");
  expect(renderToStaticMarkup(createElement(HelpPolicy, { policy: null }))).toContain("Chính sách commission hiện chưa được công bố.");
});
test("an open dispute still permits statements after its response deadline and shows owner questions", () => {
  const dispute = { id, state: "open", reason: "not_delivered", trigger: "overdue", respondBy: "2020-01-01T00:00:00.000Z", ruling: null,
    statements: [{ authorRole: "buyer", kind: "opening", text: "Synthetic", createdAt: "2020-01-01T00:00:00.000Z" }, { authorRole: "owner", kind: "question", text: "Synthetic question", createdAt: "2020-01-01T00:00:00.000Z" }] } as NonNullable<ResolutionView["resolution"]["dispute"]>;
  const markup = renderToStaticMarkup(createElement(DisputePanel, { dispute, role: "creator", disabled: false, onStatement: vi.fn(), onWithdraw: vi.fn() }));
  expect(markup).toContain("Câu hỏi của Pawket"); expect(markup).not.toContain("<fieldset disabled"); expect(markup).not.toContain("Rút khiếu nại");
});
test("party ruling displays the latest corrected refund and its date alongside the original ruling", () => {
  const correctedAt = "2026-10-09T00:00:00.000Z";
  const view = resolutionSchema.parse({ ...initial, resolution: { ...initial.resolution, dispute: { id, state: "ruled", reason: "not_delivered", trigger: "overdue",
    respondBy: null, statements: [], ruling: { outcome: "close", refundAmountVnd: 200_000, currentRefundAmountVnd: 100_000, correctedAt, reasoning: "Synthetic reasoning", ruledAt: "2026-10-08T00:00:00.000Z" } } } });
  const node = document.createElement("div"); node.innerHTML = renderToStaticMarkup(createElement(DisputePanel,
    { dispute: view.resolution.dispute!, role: "buyer", disabled: false, onStatement: vi.fn(), onWithdraw: vi.fn() }));
  const fields = Array.from(node.querySelectorAll("dl > div"));
  expect(fields.find((field) => field.querySelector("dt")?.textContent === "Số tiền hoàn")?.querySelector("dd")?.textContent).toBe(formatVnd(100_000));
  expect(node.textContent?.includes(formatVnd(200_000))).toBe(true);
  expect(node.querySelector<HTMLTimeElement>(`time[datetime="${correctedAt}"]`)).not.toBeNull();
});
test("paid-close creator files show no preview or download controls for the buyer", () => {
  const markup = renderToStaticMarkup(createElement(AttachedFileList, { order, withdrawn: true, files: [{ fileId: id, name: null, sizeBytes: 16,
    detectedType: "png", sha256: `sha256:${"a".repeat(64)}`, previewable: true, availability: "available" }] }));
  expect(markup.includes("disposition=")).toBe(false); expect(markup.includes("<img")).toBe(false); expect(markup.includes("Không còn quyền tải tệp này sau khi đơn đã hủy.")).toBe(true);
});
