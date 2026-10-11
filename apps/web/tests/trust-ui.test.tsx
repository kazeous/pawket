// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
const { execute, solve } = vi.hoisted(() => ({ execute: vi.fn(), solve: vi.fn().mockResolvedValue(1234) }));
vi.mock("../src/app/creators/[handle]/report-proof", () => ({ solveReportChallenge: solve }));
vi.mock("../src/ui/commissions/commission-session", () => ({ useCommissionSession: () => async () => "synthetic-actor",
  useCommissionCommand: () => ({ execute, retry: vi.fn(), locked: false, pending: false, code: null }), CommandFeedback: () => null }));
import { CommissionMessage } from "../src/ui/commissions/commission-thread";
import { AttachedFileList } from "../src/ui/commissions/reference-files";
import { MyCases } from "../src/ui/help/my-cases";
import { AppealForm } from "../src/ui/trust/appeal-form";
import { EnforcementBanner } from "../src/ui/trust/enforcement-banner";
import { ReportDialog } from "../src/ui/trust/report-dialog";
import { SubmissionCard } from "../src/ui/commissions/submission-card";
import { CommissionDetail } from "../src/ui/commissions/commission-detail";
import { fixtureOrder } from "./resolution-fixture-data";
import type { OrderView, ThreadView } from "../src/ui/commissions/commission-client";
import type { PenaltyView } from "../src/ui/trust/trust-client";
const id = "10000000-0000-4000-8000-000000000001";
const at = "2026-10-10T00:00:00.000Z";
const order = { id, role: "buyer", state: "in_progress" } as OrderView["order"];
const message = { sequence: 1, kind: "message", id, author: "creator", text: "Other participant", hidden: false, files: [], createdAt: at } as Extract<ThreadView["items"][number], { kind: "message" }>;
const penalty: PenaltyView = { penaltyId: id, kind: "restriction", restriction: "reporting", target: null, reasonCategoryLabel: "Spam hoặc lừa đảo",
  explanation: "Giải thích dành cho bạn", startsAt: at, endsAt: null, endedAt: null, state: "active", acknowledgedAt: null,
  canAppeal: true, appealDeadline: "2099-10-24T00:00:00.000Z", appealState: null };
const markup = (node: ReturnType<typeof createElement>) => renderToStaticMarkup(node);
afterEach(() => { vi.unstubAllGlobals(); execute.mockReset(); });
test.each(["buyer", "creator"] as const)("report action shows on the other participant's message only for %s", (role) => {
  for (const author of ["buyer", "creator"] as const) {
    expect(markup(createElement(CommissionMessage, { order: { ...order, role }, message: { ...message, author }, trustMode: "enabled" })).includes("Báo cáo")).toBe(role !== author);
  }
});
test("hidden message renders the notice and no text even with enforcement disabled", () => {
  const html = markup(createElement(CommissionMessage, { order, message: { ...message, hidden: true, text: "must-not-render" }, trustMode: "disabled" }));
  expect(html).toContain("Tin nhắn này đã bị Pawket ẩn vì vi phạm quy định cộng đồng."); expect(html).not.toContain("must-not-render"); expect(html).not.toContain("Báo cáo");
});
test("hidden file has no metadata, download or preview link", () => {
  const html = markup(createElement(AttachedFileList, { order, files: [{ fileId: id, name: "private-name", sizeBytes: 16, detectedType: "png", sha256: `sha256:${"a".repeat(64)}`, previewable: true, availability: "hidden" }], trustMode: "enabled", reportable: true }));
  expect(html).toContain("Tệp này đã bị Pawket ẩn vì vi phạm quy định cộng đồng.");
  for (const secret of ["disposition=", "<img", "private-name", "sha256:", "Báo cáo"]) expect(html).not.toContain(secret);
});
test("my cases lists penalty explanation and appeal until the effective deadline", () => {
  const cases = { disputes: [], refunds: [], lateClaims: [], penalties: [penalty], reportsFiled: [], hides: [], appeals: [] };
  const render = (row: PenaltyView) => markup(createElement(MyCases, { cases: { ...cases, penalties: [row] }, orderRoles: {}, trustMode: "enabled" }));
  expect(render(penalty)).toContain(penalty.explanation); expect(render(penalty)).toContain("Kháng nghị");
  expect(render({ ...penalty, appealDeadline: "2020-01-01T00:00:00.000Z" })).not.toContain(">Kháng nghị<");
  expect(render({ ...penalty, canAppeal: false })).not.toContain(">Kháng nghị<");
  expect(markup(createElement(MyCases, { cases, orderRoles: {}, trustMode: "disabled" }))).not.toContain(penalty.explanation);
});
test("disabled and own-content report actions are absent", () => {
  const target = { kind: "commission_brief" as const, orderId: id };
  for (const props of [{ mode: "disabled" as const, ownContent: false }, { mode: "enabled" as const, ownContent: true }]) expect(markup(createElement(ReportDialog, { target, ...props, guest: true }))).toBe("");
});
test("submission files offer reporting only to the buyer", () => {
  const submission = { sequence: 1, kind: "submission" as const, id, submissionKind: "draft" as const, note: null, submittedAt: at, late: false,
    response: null, responseNote: null, respondedAt: null, actionable: false,
    files: [{ fileId: id, name: "synthetic.png", sizeBytes: 16, detectedType: "png" as const, sha256: `sha256:${"a".repeat(64)}`, previewable: true, availability: "available" as const }] };
  for (const role of ["buyer", "creator"] as const) expect(markup(createElement(SubmissionCard, { submission, order: { ...order, role }, disabled: false, onUpdated: vi.fn(), trustMode: "enabled" })).includes("Báo cáo")).toBe(role === "buyer");
});
test("brief reporting appears only for the creator and follows enforcement mode", () => {
  for (const role of ["buyer", "creator"] as const) for (const mode of ["disabled", "enabled"] as const) {
    const initial: OrderView = { controls: { intakeMode: "enabled", paymentsMode: "manual_only", fulfillmentMode: "enabled" }, order: { ...fixtureOrder, role, state: "requested", confirmedAt: null } };
    const html = markup(createElement(CommissionDetail, { initial, trustMode: mode }));
    expect(html.includes("Báo cáo")).toBe(role === "creator" && mode === "enabled");
  }
});
test("decided appeals show reasoning and pending appeals omit it", () => {
  const cases = { disputes: [], refunds: [], lateClaims: [], appeals: [{ appealId: id, penaltyId: id, hideId: null, state: "upheld" as const, reasoning: "Giải thích kết luận", createdAt: at, decidedAt: at }] };
  expect(markup(createElement(MyCases, { cases, orderRoles: {}, trustMode: "enabled" }))).toContain("Giải thích kết luận");
  expect(markup(createElement(MyCases, { cases: { ...cases, appeals: [{ ...cases.appeals[0]!, state: "open", decidedAt: null }] }, orderRoles: {}, trustMode: "enabled" }))).not.toContain("Giải thích kết luận");
});
test("guest package report solves a POST challenge in the browser and sends only the proof", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const fetch = vi.fn().mockImplementation(async (path: string) => new Response(JSON.stringify(path.endsWith("challenge") ? { token: "synthetic-token", difficulty: 18 } : { accepted: true, reportReference: "report:v2:synthetic" }), { headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    const target = { kind: "commission_package" as const, packageId: id, revisionId: id };
    await act(async () => root.render(createElement(ReportDialog, { target, mode: "enabled", guest: true })));
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    const dialog = document.querySelector('[role="alertdialog"]')!; expect(dialog.textContent).toContain("Báo cáo nội dung");
    await act(async () => dialog.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(fetch.mock.calls[0]![0]).toBe("/api/v1/reports/challenge"); expect(fetch.mock.calls[0]![1].method).toBe("POST");
    expect(solve).toHaveBeenCalledWith({ token: "synthetic-token", difficulty: 18 }, expect.any(AbortSignal), expect.any(Function));
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ target, reason: "privacy", detail: "", challenge: { token: "synthetic-token", solution: 1234 } });
    expect(dialog.textContent).toContain("Đã gửi báo cáo. Pawket sẽ xem xét; người bị báo cáo không biết bạn là ai.");
  } finally { await act(async () => root.unmount()); container.remove(); }
});
test("appeal form enforces 4,000 code points on submit", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(AppealForm, { target: { penaltyId: id }, onSubmitted: vi.fn() })));
    const form = container.querySelector("form")!; const textarea = form.querySelector("textarea")!;
    textarea.value = "😀".repeat(4001); await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(execute).not.toHaveBeenCalled(); expect(textarea.getAttribute("aria-invalid")).toBe("true");
    textarea.value = "😀".repeat(4000); await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(execute).toHaveBeenCalledWith("/api/v1/help/appeals", { target: { penaltyId: id }, statement: "😀".repeat(4000) }, expect.any(Function));
  } finally { await act(async () => root.unmount()); container.remove(); }
});
test("warning banner disappears only after acknowledge succeeds and stays in my cases", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const warning = { ...penalty, kind: "warning" as const, restriction: null, canAppeal: false };
  try {
    await act(async () => root.render(createElement(EnforcementBanner, { penalties: [warning], mode: "enabled" })));
    expect(container.textContent).toContain("Tài khoản của bạn đã nhận một cảnh cáo.");
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(container.textContent).toContain("Tôi đã hiểu");
    const call = execute.mock.calls[0]!; expect(call[0]).toBe(`/api/v1/help/warnings/${id}/acknowledge`);
    await act(async () => call[2]({ acknowledged: true })); expect(container.textContent).not.toContain("Tài khoản của bạn đã nhận một cảnh cáo.");
    expect(markup(createElement(MyCases, { cases: { disputes: [], refunds: [], lateClaims: [], penalties: [{ ...warning, acknowledgedAt: at }] }, orderRoles: {}, trustMode: "enabled" }))).toContain("Cảnh cáo");
  } finally { await act(async () => root.unmount()); container.remove(); }
  expect(markup(createElement(EnforcementBanner, { penalties: [warning], mode: "disabled" }))).toBe("");
});
