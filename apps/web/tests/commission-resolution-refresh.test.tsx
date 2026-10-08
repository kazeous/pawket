// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const { execute, read, verify } = vi.hoisted(() => ({ execute: vi.fn(), read: vi.fn(), verify: vi.fn(async () => "synthetic-actor") }));
vi.mock("../src/ui/commissions/commission-session", () => ({ useCommissionSession: () => verify,
  useCommissionCommand: () => ({ execute, retry: vi.fn(), locked: false, pending: false, code: null }), CommandFeedback: () => null }));
vi.mock("../src/ui/commissions/commission-client", async (original) => ({ ...await original<object>(), commissionRead: read }));
vi.mock("../src/ui/commissions/commission-thread", () => ({ CommissionThread: () => createElement("section", { "data-commission-thread": true }) }));
vi.mock("../src/ui/commissions/reference-files", () => ({ ReferenceFileList: () => null, ReferenceFilePicker: () => null }));
import { CommissionDetail } from "../src/ui/commissions/commission-detail";
import { LateClaimPanel } from "../src/ui/resolutions/late-claim-panel";
import type { OrderView } from "../src/ui/commissions/commission-client";
import { resolutionSchema, type ResolutionView } from "../src/ui/resolutions/resolution-client";
import { fixtureOrder, fixtureRefund, obligationId, orderId } from "./resolution-fixture-data";

const at = "2026-10-08T00:00:00.000Z";
const controls: OrderView["controls"] = { intakeMode: "enabled", paymentsMode: "manual_only", fulfillmentMode: "enabled" };
const empty = (role: "buyer" | "creator"): ResolutionView => resolutionSchema.parse({ controls: { mode: "enabled" }, resolution: { role,
  proposals: { pending: null, history: [] }, dispute: null, refunds: [], lateClaim: null,
  actions: { canPropose: false, canOpenDispute: false, disputeTrigger: null, disputeTriggerEndsAt: null, canCancelAfterSuspension: false } } });
let container: HTMLDivElement; let root: Root;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(at); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // React's duplicate-key diagnostic must not print component keys or private DOM content.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  execute.mockReset(); read.mockReset(); verify.mockClear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const flush = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(5); }); };
async function mount(detail: OrderView, view: ResolutionView, current: () => { detail: OrderView; view: ResolutionView }) {
  read.mockImplementation(async (path, schema) => schema.parse(path.endsWith("/resolution") ? current().view : current().detail));
  await act(async () => root.render(createElement(CommissionDetail, { initial: detail, initialResolution: view, refundBanks: { "970436": "Synthetic bank" } })));
  await flush();
}
async function click(label: string) {
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter((button) => button.textContent === label);
  expect(buttons.length).toBe(1); expect(buttons[0]!.disabled).toBe(false);
  await act(async () => buttons[0]!.click()); await flush();
}
async function submit(form: HTMLFormElement) { expect(form.checkValidity()).toBe(true); await act(async () => form.requestSubmit()); await flush(); }
function singlePanel() {
  expect(container.querySelectorAll("[data-resolution-panel]").length).toBe(1);
  expect(container.querySelectorAll("[data-commission-thread]").length).toBe(1);
  const ids = Array.from(container.querySelectorAll("[id]"), (node) => node.id);
  expect(new Set(ids).size).toBe(ids.length);
}
test.each([true, false])("closed-order copy describes the paid=%s path", async (paid) => {
  const detail: OrderView = { controls, order: { ...fixtureOrder, state: "closed", closeReason: paid ? "cancelled_by_agreement" : "buyer_withdrawn", confirmedAt: paid ? at : null } };
  const view = empty("buyer"); await mount(detail, view, () => ({ detail, view }));
  const copy = paid ? "Đơn đã đóng sau khi thanh toán. Xem phần hoàn tiền bên dưới nếu có khoản cần hoàn."
    : "Đơn đã đóng trước khi thanh toán. Nếu bạn đã chuyển khoản sau khi đơn đóng, hãy gửi yêu cầu đối chiếu bên dưới.";
  expect(container.textContent?.includes(copy)).toBe(true);
});

test.each(["accept", "decline"] as const)("proposal %s refresh removes the pending region and retains one resolution panel", async (response) => {
  let detail: OrderView = { controls, order: { ...fixtureOrder, role: "creator" } };
  let view = empty("creator"); view = { ...view, resolution: { ...view.resolution, proposals: { history: [], pending: {
    id: orderId, proposerRole: "buyer", kind: "cancel_with_refund", refundAmountVnd: 100_000, note: "Synthetic", state: "pending", stale: false,
    respondBy: "2026-10-11T00:00:00.000Z", createdAt: at, endedAt: null } } } };
  execute.mockImplementation((_path, payload, done) => {
    expect(payload.response).toBe(response);
    if (response === "accept") detail = { ...detail, order: { ...detail.order, state: "closed", closeReason: "cancelled_by_agreement", version: 2 } };
    view = { ...view, resolution: { ...view.resolution, proposals: { pending: null, history: [] } } }; done({ proposalId: orderId });
  });
  await mount(detail, view, () => ({ detail, view }));
  if (response === "accept") { await click("Đồng ý"); await click("Xác nhận đồng ý và kết thúc đơn"); } else await click("Từ chối");
  expect(execute.mock.calls.length).toBe(1); singlePanel();
  expect(container.querySelectorAll('[aria-label="Đề nghị đang chờ"]').length).toBe(0);
  expect(container.querySelector("[data-order-state]")?.textContent).toBe(response === "accept" ? "Đã đóng" : "Đang thực hiện");
});

test("saving a refund destination replaces the old form without duplicate fields or panels", async () => {
  const detail: OrderView = { controls, order: { ...fixtureOrder, state: "closed", closeReason: "cancelled_by_agreement" } };
  let view = empty("buyer"); view = { ...view, resolution: { ...view.resolution, refunds: [{ ...fixtureRefund, state: "awaiting_destination", bankBin: null, bankName: null, suffix: null, dueAt: null }] } };
  execute.mockImplementation((_path, _payload, done) => {
    view = { ...view, resolution: { ...view.resolution, refunds: [{ ...fixtureRefund, version: 2 }] } }; done({ version: 2 });
  });
  await mount(detail, view, () => ({ detail, view }));
  const form = container.querySelector<HTMLFormElement>('[aria-label="Hoàn tiền"] form')!;
  form.querySelector<HTMLSelectElement>('[name="bank"]')!.value = "970436";
  form.querySelector<HTMLInputElement>('[name="account"]')!.value = "000000004321";
  form.querySelector<HTMLInputElement>('[name="holder"]')!.value = "SYNTHETIC BUYER";
  await submit(form);
  expect(execute.mock.calls.length).toBe(1); singlePanel();
  expect(container.querySelectorAll('[aria-label="Hoàn tiền"]').length).toBe(1);
  expect(container.textContent?.includes("Chờ chuyển hoàn tiền")).toBe(true);
  expect(container.textContent?.includes("Chờ tài khoản nhận hoàn tiền")).toBe(false);
  expect(container.querySelectorAll('[name="account"]').length).toBe(1);
  expect(container.querySelector<HTMLInputElement>('[name="account"]')!.value === "").toBe(true);
});

test("recording a refund send removes the revealed account and send form after refresh", async () => {
  const detail: OrderView = { controls, order: { ...fixtureOrder, role: "creator" } };
  let view = empty("creator"); view = { ...view, resolution: { ...view.resolution, refunds: [fixtureRefund] } };
  execute.mockImplementation((path, _payload, done) => {
    if (path.endsWith("/reveal")) done({ bankName: "Synthetic bank", accountNumber: "000000004321", accountHolder: "SYNTHETIC BUYER",
      amountVnd: fixtureRefund.amountVnd, reference: fixtureRefund.reference, qrPayload: "0".repeat(50), dueAt: fixtureRefund.dueAt });
    else {
      view = { ...view, resolution: { ...view.resolution, refunds: [{ ...fixtureRefund, state: "sent", version: 2, currentSendId: obligationId,
        hasRecordedSend: true, confirmBy: "2026-10-15T00:00:00.000Z", sends: [{ id: obligationId, transferDate: "2026-10-08", bankReference: "SYNTHETIC", recordedAt: at, note: null }] }] } };
      done({ version: 2 });
    }
  });
  await mount(detail, view, () => ({ detail, view })); await click("Xem thông tin chuyển hoàn tiền");
  expect(container.querySelectorAll('[aria-label="Thông tin chuyển hoàn tiền"]').length).toBe(1);
  const form = container.querySelector<HTMLFormElement>('[aria-label="Thông tin chuyển hoàn tiền"] form')!;
  form.querySelector<HTMLInputElement>('[name="date"]')!.value = "2026-10-08";
  form.querySelector<HTMLInputElement>('[name="reference"]')!.value = "SYNTHETIC";
  await submit(form);
  expect(execute.mock.calls.length).toBe(2); singlePanel();
  expect(container.querySelectorAll('[aria-label="Thông tin chuyển hoàn tiền"]').length).toBe(0);
  expect(container.querySelectorAll('[name="date"]').length).toBe(0);
  expect(container.textContent?.includes("000000004321")).toBe(false);
  expect(container.textContent?.includes("Nghệ sĩ đã ghi nhận chuyển")).toBe(true);
});

test("late claim native validation blocks seconds and submits a minute-aligned transfer time", async () => {
  const onRefresh = vi.fn(async () => undefined);
  execute.mockImplementation((_path, _payload, done) => done({ claimId: orderId }));
  await act(async () => root.render(createElement(LateClaimPanel, { order: { ...fixtureOrder, state: "closed", confirmedAt: null },
    claim: null, disabled: false, onRefresh })));
  await click("Tôi đã chuyển khoản sau khi đơn đóng");
  const form = container.querySelector<HTMLFormElement>("form")!;
  const time = form.querySelector<HTMLInputElement>('[name="at"]')!;
  time.value = "2026-10-07T23:59:31";
  form.querySelector<HTMLInputElement>('[name="amount"]')!.value = "500000";
  form.querySelector<HTMLInputElement>('[name="reference"]')!.value = "SYNTHETIC";
  expect(time.validity.stepMismatch).toBe(true);
  await act(async () => form.requestSubmit()); expect(execute.mock.calls.length).toBe(0);
  time.value = "2026-10-07T23:59"; await submit(form);
  expect(execute.mock.calls.length).toBe(1); expect(onRefresh.mock.calls.length).toBe(1);
  expect(container.querySelectorAll("form").length).toBe(0);
});
