// @vitest-environment jsdom
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../src/ui/tips/tip-client", async (original) => ({ ...await original<typeof import("../src/ui/tips/tip-client")>(), tipRequest: request }));
import { CaseQueue } from "../src/ui/cases/case-queue";
import { CaseDetail } from "../src/ui/cases/case-detail";
import { PenaltyForm } from "../src/ui/trust/penalty-form";
import { ReportCasePanel } from "../src/ui/trust/report-case-panel";
import { AppealCasePanel } from "../src/ui/trust/appeal-case-panel";
import { PolicyPublisher } from "../src/ui/trust/policy-publisher";
import { PenaltiesTab } from "../src/ui/trust/penalties-tab";
import { EvidenceTabs, EvidenceView } from "../src/ui/cases/evidence-tabs";
import { TipRequestError } from "../src/ui/tips/tip-client";
import { ContentReportWorkbench } from "../src/app/admin/content-reports/content-report-workbench";
import { caseDetailSchema, type TrustCaseDetailView } from "../src/ui/cases/case-client";
const id = "10000000-0000-4000-8000-000000000001";
const at = "2026-10-07T00:00:00.000Z";
const parties = [{ userId: "creator", label: "Nghệ sĩ" }, { userId: "buyer", label: "Người mua" }];
const report = () => caseDetailSchema.parse({ case: { caseId: id, orderId: id, sourceId: id, sourceType: "commission_brief", kind: "report", state: "open", resolutionKind: null, policyRevisionId: null, version: 2, openedAt: at, resolvedAt: null, events: [], accessLog: [], parties, activeHideId: null } }).case as TrustCaseDetailView;
const appeal = () => caseDetailSchema.parse({ case: { ...report(), kind: "appeal", sourceType: "trust_appeal", appealAction: { penaltyId: id, kind: "restriction", restriction: "reporting", target: null, endsAt: "2027-01-01T00:00:00.000Z" } } }).case as TrustCaseDetailView;
afterEach(() => { request.mockReset(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function markup(element: ReactElement) { const node = document.createElement("div"); node.innerHTML = renderToStaticMarkup(element); return node; }
test.each(["report", "appeal"] as const)("%s tabs never offer order-wide evidence", (kind) => {
  const node = markup(<EvidenceTabs kind={kind} sourceType={kind === "report" ? "commission_brief" : "trust_appeal"} disabled={false} onRead={vi.fn()} onFile={vi.fn()} />);
  const navigation = node.querySelector('[aria-label="Mục bằng chứng"]')!;
  for (const label of ["Thông tin đơn hàng", "Tin nhắn và bàn giao", "Khiếu nại và hoàn tiền"]) expect(navigation.textContent).not.toContain(label);
});
async function mounted(element: ReactElement, run: (node: HTMLDivElement) => Promise<void>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); const node = document.createElement("div"); document.body.append(node); const root = createRoot(node);
  try { await act(async () => root.render(element)); await run(node); } finally { await act(async () => root.unmount()); node.remove(); }
}
const button = (node: HTMLDivElement, text: string) => Array.from(node.querySelectorAll("button")).find((item) => item.textContent === text)!;
const submit = async (node: HTMLDivElement) => act(async () => { node.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
async function select(node: HTMLDivElement, name: string, value: string) { await act(async () => { const input = node.querySelector<HTMLSelectElement>(`[name="${name}"]`)!; input.value = value; input.dispatchEvent(new Event("change", { bubbles: true })); }); }
test("queue shows report and appeal kinds only when enabled", () => {
  const enabled = markup(<CaseQueue initialCases={[]} enforcementEnabled actorUserId="owner" />);
  for (const text of ["Báo cáo", "Kháng nghị", "Biện pháp"]) expect(enabled.textContent).toContain(text);
  const disabled = markup(<CaseQueue initialCases={[]} />); expect(disabled.querySelector('option[value="report"]')).toBeNull(); expect(disabled.textContent).not.toContain("Biện pháp");
});
test("report panel hides Hide for brief cases", () => {
  const node = markup(<ReportCasePanel detail={report()} disabled={false} onSubmit={vi.fn()} />);
  expect(node.textContent).not.toContain("Ẩn nội dung"); expect(node.textContent).toContain("Áp dụng biện pháp"); expect(node.textContent).toContain("Yêu cầu sáng tác");
});
test("penalty form offers only parties of the source and previews account logout", async () => {
  const send = vi.fn(); await mounted(<PenaltyForm parties={parties} disabled={false} onSubmit={send} />, async (node) => {
    expect(Array.from(node.querySelectorAll('[name="subjectUserId"] option'), (item) => item.getAttribute("value"))).toEqual(["creator", "buyer"]);
    await select(node, "kind", "suspension"); await select(node, "target", "account"); expect(node.querySelector('[role="status"]')?.textContent).toBe("Tạm khóa tài khoản sẽ đăng xuất người dùng khỏi mọi phiên.");
    node.querySelector<HTMLTextAreaElement>('[name="explanation"]')!.value = "Lý do"; await submit(node);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ action: "penalty", subjectUserId: "creator", kind: "suspension", target: "account" }));
  });
});
test("reduced decision requires a milder replacement", async () => {
  const send = vi.fn(); await mounted(<AppealCasePanel detail={appeal()} disabled={false} onSubmit={send} now={new Date(at)} />, async (node) => {
    await select(node, "decision", "reduced"); node.querySelector<HTMLTextAreaElement>('[name="reasoning"]')!.value = "Giảm thời hạn";
    await submit(node); expect(send).not.toHaveBeenCalled();
    node.querySelector<HTMLInputElement>('[name="endsAt"]')!.value = "2028-01-01T00:00"; await submit(node); expect(send).not.toHaveBeenCalled();
    node.querySelector<HTMLInputElement>('[name="endsAt"]')!.value = "2026-12-01T00:00"; await submit(node);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ action: "decide_appeal", decision: "reduced", expectedCaseVersion: 2, replacement: expect.objectContaining({ kind: "restriction", restriction: "reporting" }) }));
  });
});
test("policy publisher sends expectedRevisionNumber and hides publish while disabled", async () => {
  const policies = [{ kind: "community_rules" as const, current: { revisionId: id, kind: "community_rules" as const, revisionNumber: 3, document: "Quy tắc", effectiveAt: at } }, { kind: "enforcement_appeals" as const, current: null }];
  expect(markup(<PolicyPublisher initialPolicies={policies} actorUserId="owner" enforcementEnabled={false} />).querySelector('button[type="submit"]')).toBeNull();
  request.mockResolvedValue({ policies }); await mounted(<PolicyPublisher initialPolicies={policies} actorUserId="owner" enforcementEnabled />, async (node) => {
    node.querySelector<HTMLTextAreaElement>('textarea')!.value = "Quy tắc mới"; await submit(node);
    expect(request.mock.calls[0]?.slice(0, 2)).toEqual(["/api/v1/admin/policies", expect.objectContaining({ method: "POST", body: JSON.stringify({ kind: "community_rules", expectedRevisionNumber: 3, document: "Quy tắc mới" }) })]);
  });
});
test("content report workbench offers a penalty for the creator", async () => {
  vi.useFakeTimers(); vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ reports: [{ reportId: id, target: { targetType: "page", targetId: id, publicationRevisionId: id }, reason: "other", detail: null, state: "open", version: 1, snapshot: { pageId: id, canonicalHandle: "creator", displayName: "Nghệ sĩ", showcaseTitle: null }, activeHold: null, priorActions: [] }] }))));
  request.mockImplementation(async (_path: string, init?: RequestInit) => init?.method === "POST" ? {} : { parties: [parties[0]] });
  await mounted(<ContentReportWorkbench initialActorUserId="owner" enforcementEnabled />, async (node) => {
    await act(async () => { await vi.advanceTimersByTimeAsync(5); }); await act(async () => button(node, "Áp dụng biện pháp").click());
    expect(node.querySelectorAll('[name="subjectUserId"] option')).toHaveLength(1);
    node.querySelector<HTMLTextAreaElement>('[name="explanation"]')!.value = "Lý do"; await submit(node);
    expect(request).toHaveBeenCalledWith(`/api/v1/admin/content-reports/${id}/penalty`, expect.objectContaining({ method: "POST", body: expect.stringContaining('"subjectUserId":"creator"') }), 1_048_576);
    expect(node.textContent).toContain("Đã áp dụng biện pháp cho nghệ sĩ.");
  });
});
test("disabled case detail refuses to render a trust panel or fetch evidence", () => {
  const node = markup(createElement(CaseDetail, { initial: report(), caseId: id, actorUserId: "owner" })); expect(node.textContent).not.toContain("Áp dụng biện pháp"); expect(node.textContent).not.toContain("Xem bằng chứng"); expect(request).not.toHaveBeenCalled();
});
test("penalty form refuses foreign subjects, long explanations and control characters", async () => {
  const send = vi.fn(); await mounted(<PenaltyForm parties={parties} disabled={false} onSubmit={send} />, async (node) => {
    const explanation = node.querySelector<HTMLTextAreaElement>('[name="explanation"]')!;
    for (const text of ["x".repeat(2001), "reason\u0000", ""]) { explanation.value = text; await submit(node); }
    expect(send).not.toHaveBeenCalled(); explanation.value = "e\u0301";
    const subject = node.querySelector<HTMLSelectElement>('[name="subjectUserId"]')!; subject.add(new Option("Foreign", "foreign")); subject.value = "foreign"; await submit(node); expect(send).not.toHaveBeenCalled();
    subject.value = "buyer"; await submit(node); expect(send).toHaveBeenCalledWith(expect.objectContaining({ subjectUserId: "buyer", explanation: "é" }));
  });
});
test("report Restore and Close bind the current hide and case version", async () => {
  const send = vi.fn(); await mounted(<ReportCasePanel detail={{ ...report(), sourceType: "commission_message", activeHideId: id }} disabled={false} onSubmit={send} />, async (node) => {
    expect(Array.from(node.querySelectorAll('[name="operation"] option'), (option) => option.textContent)).toEqual(["Khôi phục nội dung", "Đóng báo cáo"]);
    node.querySelector<HTMLInputElement>('[name="reason"]')!.value = "Khôi phục"; await submit(node);
    expect(send).toHaveBeenCalledWith({ action: "restore", expectedCaseVersion: 2, hideId: id, reason: "Khôi phục" });
    await select(node, "operation", "close_report"); await select(node, "resolution", "actioned"); await submit(node);
    expect(send).toHaveBeenLastCalledWith({ action: "close_report", expectedCaseVersion: 2, resolution: "actioned", reason: "Khôi phục" });
  });
});
test.each([["report", "commission_package", ["Ngữ cảnh báo cáo", "Phiên bản gói commission"]], ["report", "commission_brief", ["Ngữ cảnh báo cáo", "Yêu cầu sáng tác"]], ["appeal", "trust_appeal", ["Nguồn kháng nghị"]]] as const)("%s evidence exposes source-specific tabs without fetching", (kind, sourceType, labels) => {
  const read = vi.fn(); const node = markup(<EvidenceTabs kind={kind} sourceType={sourceType} disabled={false} onRead={read} onFile={vi.fn()} />);
  for (const label of labels) expect(node.textContent).toContain(label); expect(node.textContent).not.toContain("Thông tin đơn hàng"); expect(read).not.toHaveBeenCalled();
});
test("report and appeal evidence renders owner identity, statements and formatted times as text", () => {
  const node = markup(<EvidenceView section="appeal_source" value={{ reports: [{ reporterUserId: "reporter", reasonCategory: "privacy", createdAt: at, detail: "<script>private</script>" }], appeal: { statement: "Trình bày" }, action: { kind: "suspension", target: "account", explanation: "Giải thích" } }} />);
  for (const text of ["reporter", "Quyền riêng tư", "Trình bày", "Tạm khóa", "Tài khoản", "Giải thích"]) expect(node.textContent).toContain(text);
  expect(node.querySelector("time")?.dateTime).toBe(at); expect(node.textContent).not.toContain(at); expect(node.querySelector("script")).toBeNull();
});
test.each(["report_context", "package_revision", "brief", "appeal_source"] as const)("%s evidence renders trust fields and translates a null reporter in the UI", (section) => {
  const node = markup(<EvidenceView section={section} value={{ reports: [{ reporterUserId: null, detail: "Chi tiết" }], hidden: true, target: "account", messages: [{ text: "Ngữ cảnh" }] }} />);
  for (const text of ["Khách chưa đăng nhập", "Chi tiết", "Đã ẩn", "Tài khoản", "Ngữ cảnh"]) expect(node.textContent).toContain(text);
});
test("policy publisher shows a policy-specific version conflict and permits a fresh attempt", async () => {
  const policies = [{ kind: "community_rules" as const, current: { revisionId: id, kind: "community_rules" as const, revisionNumber: 3, document: "Quy tắc", effectiveAt: at } }];
  request.mockRejectedValue(new TipRequestError("version_conflict"));
  await mounted(<PolicyPublisher initialPolicies={policies} actorUserId="owner" enforcementEnabled />, async (node) => {
    node.querySelector<HTMLTextAreaElement>("textarea")!.value = "Quy tắc mới"; await submit(node);
    expect(node.querySelector('[role="alert"]')?.textContent).toBe("Chính sách đã có phiên bản mới. Tải lại trang rồi thử lại.");
    expect(node.textContent).not.toContain("Vụ việc đã thay đổi");
    expect(button(node, "Xuất bản").disabled).toBe(false);
    expect(node.textContent).not.toContain("Kiểm tra lại cùng yêu cầu");
  });
});
test("policy limit is measured in normalized code points and first publish sends revision zero", async () => {
  const policies = [{ kind: "community_rules" as const, current: null }, { kind: "enforcement_appeals" as const, current: null }]; request.mockResolvedValue({ policies });
  await mounted(<PolicyPublisher actorUserId="owner" initialPolicies={policies} enforcementEnabled />, async (node) => {
    const textarea = node.querySelector<HTMLTextAreaElement>("textarea")!; textarea.value = "x".repeat(16_001); await submit(node); expect(request).not.toHaveBeenCalled();
    textarea.value = "🦊".repeat(16_000); await submit(node); expect(JSON.parse(request.mock.calls[0]![1].body)).toMatchObject({ expectedRevisionNumber: 0, document: "🦊".repeat(16_000) });
  });
});
test.each(["dependency_unavailable", "IDENTITY_UNAVAILABLE"])("active penalties lift retries the same request after uncertain %s", async (code) => {
  vi.useFakeTimers(); const penalty = { penaltyId: id, subjectUserId: "creator", kind: "warning", restriction: null, target: null, reasonCategory: "other", explanation: "Lý do", startsAt: at, endsAt: null, sourceCaseId: id, sourcePublicReportId: null, state: "active" };
  let failed = false; request.mockImplementation(async (_path: string, init?: RequestInit) => { if (init?.method !== "POST") return { penalties: [penalty] }; if (!failed) { failed = true; throw new TipRequestError(code); } return {}; });
  await mounted(<PenaltiesTab actorUserId="owner" />, async (node) => {
    await act(async () => { await vi.advanceTimersByTimeAsync(5); }); node.querySelector<HTMLInputElement>('[name="reason"]')!.value = "Gỡ"; await submit(node);
    expect(button(node, "Gỡ biện pháp").disabled).toBe(true); await act(async () => button(node, "Kiểm tra lại cùng yêu cầu").click());
    const posts = request.mock.calls.filter((call) => call[1]?.method === "POST"); expect(posts).toHaveLength(2); expect(posts[1]![1]).toBe(posts[0]![1]);
    expect(new Headers(posts[0]![1].headers).get("x-pawket-actor")).toBe("owner"); expect(posts[0]![0]).toBe(`/api/v1/admin/penalties/${id}/lift`);
  });
});
test("a case command retains its key when the OIDC wrapper returns an uncertain result", async () => {
  let failed = false; request.mockImplementation(async (_path: string, init?: RequestInit) => { if (init?.method !== "POST") return { case: report() }; if (!failed) { failed = true; throw new TipRequestError("IDENTITY_UNAVAILABLE"); } return {}; });
  await mounted(<CaseDetail initial={report()} caseId={id} actorUserId="owner" enforcementEnabled />, async (node) => {
    node.querySelector<HTMLInputElement>('[name="reason"]')!.value = "Đóng báo cáo"; await submit(node);
    await act(async () => button(node, "Kiểm tra lại cùng yêu cầu").click());
    const posts = request.mock.calls.filter((call) => call[1]?.method === "POST"); expect(posts).toHaveLength(2); expect(posts[0]![1]).toBe(posts[1]![1]);
  });
});
