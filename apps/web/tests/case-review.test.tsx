// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { CommandReview } from "../src/app/auth/review/[id]/review-panel";
test("dispute opening review keeps the statement key", async () => {
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ title: "Mở khiếu nại", body: JSON.stringify({ statement: "Original statement" }), ready: true, returnPath: "/commissions", expiresAt: "2026-10-20T00:00:00.000Z" })));
  try {
    await act(async () => root.render(createElement(CommandReview, { id: "synthetic", accountPortalUrl: "https://example.invalid" })));
    expect(node.querySelector("dt")?.textContent).toBe("statement"); expect(node.querySelector("dd")?.textContent).toBe("Original statement");
  } finally { await act(async () => root.unmount()); node.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});
test.each([
  ["commission_package", "Gói commission", { packageId: "private-package-id", revisionId: "private-revision-id" }],
  ["commission_brief", "Brief", { orderId: "private-order-id" }],
  ["commission_message", "Tin nhắn", { orderId: "private-order-id", messageId: "private-message-id" }],
  ["commission_file", "Tệp", { orderId: "private-order-id", fileId: "private-file-id" }],
] as const)("party report review translates %s without rendering target IDs or changing free text", async (kind, label, ids) => {
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ title: "Gửi báo cáo", body: JSON.stringify({ target: { kind, ...ids }, reason: "privacy", detail: "privacy" }), ready: true, returnPath: "/help/cases", expiresAt: "2026-10-20T00:00:00.000Z" })));
  try {
    await act(async () => root.render(createElement(CommandReview, { id: "synthetic", accountPortalUrl: "https://example.invalid" })));
    expect(Array.from(node.querySelectorAll("dt"), (field) => field.textContent)).toEqual(["Nội dung được báo cáo", "Lý do", "Chi tiết"]);
    expect(Array.from(node.querySelectorAll("dd"), (field) => field.textContent)).toEqual([label, "Quyền riêng tư", "privacy"]);
    for (const id of Object.values(ids)) expect(node.textContent).not.toContain(id);
    expect(node.textContent).not.toContain(kind);
  } finally { await act(async () => root.unmount()); node.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});
test("party appeal review labels the appealed measure and preserves the statement", async () => {
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ title: "Gửi kháng nghị", body: JSON.stringify({ target: { hideId: "synthetic-hide" }, statement: "reporting" }), ready: true, returnPath: "/help/cases", expiresAt: "2026-10-20T00:00:00.000Z" })));
  try {
    await act(async () => root.render(createElement(CommandReview, { id: "synthetic", accountPortalUrl: "https://example.invalid" })));
    expect(Array.from(node.querySelectorAll("dt"), (field) => field.textContent)).toEqual(["Biện pháp được kháng nghị", "Trình bày kháng nghị"]);
    expect(Array.from(node.querySelectorAll("dd"), (field) => field.textContent)[1]).toBe("reporting");
  } finally { await act(async () => root.unmount()); node.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});
test("owner penalty review retains its target scope and hide identifier label", async () => {
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ title: "Xử lý vụ việc", body: JSON.stringify({ action: "restore", target: "account", hideId: "synthetic-hide" }), ready: true, returnPath: "/admin/cases/synthetic", expiresAt: "2026-10-20T00:00:00.000Z" })));
  try {
    await act(async () => root.render(createElement(CommandReview, { id: "synthetic", accountPortalUrl: "https://example.invalid" })));
    expect(Array.from(node.querySelectorAll("dt"), (field) => field.textContent)).toEqual(["Thao tác", "Phạm vi", "Mã lần ẩn nội dung"]);
    expect(Array.from(node.querySelectorAll("dd"), (field) => field.textContent)).toEqual(["Khôi phục nội dung", "Tài khoản", "synthetic-hide"]);
  } finally { await act(async () => root.unmount()); node.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});
test("trust command review translates the subject, penalty and replacement without translating free text", async () => {
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ title: "Xử lý vụ việc", body: JSON.stringify({ action: "decide_appeal", decision: "reduced", expectedCaseVersion: 2, reasoning: "reporting", replacement: { kind: "restriction", restriction: "reporting", endsAt: "2026-10-20T00:00:00.000Z" } }), ready: true, returnPath: "/admin/cases/synthetic", expiresAt: "2026-10-20T00:00:00.000Z" })));
  try {
    await act(async () => root.render(createElement(CommandReview, { id: "synthetic", accountPortalUrl: "https://example.invalid" })));
    for (const label of ["Quyết định kháng nghị", "Giảm biện pháp", "Biện pháp thay thế", "Hạn chế", "Gửi báo cáo", "Phiên bản vụ việc"]) expect(node.textContent).toContain(label);
    expect(node.querySelector("time")?.dateTime).toBe("2026-10-20T00:00:00.000Z");
    expect(Array.from(node.querySelectorAll("dd")).some((field) => field.textContent === "reporting")).toBe(true);
  } finally { await act(async () => root.unmount()); node.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});
test.each(["evidence", "file"])("the shared OIDC resume page handles case %s without persisting grants", async (kind) => {
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  vi.stubGlobal("fetch", vi.fn(async (_path, init?: RequestInit) => new Response(JSON.stringify(init?.method === "POST"
    ? kind === "evidence" ? { evidence: { brief: { text: "Synthetic private evidence" } } } : { url: "https://example.invalid/synthetic-file" }
    : { title: kind === "evidence" ? "Xem bằng chứng của vụ việc" : "Xem tệp của vụ việc", body: "{}", ready: true, returnPath: "/admin/cases/synthetic", expiresAt: "2026-10-09T00:00:00Z" }), { headers: { "content-type": "application/json" } })));
  try {
    await act(async () => root.render(createElement(CommandReview, { id: "synthetic", accountPortalUrl: "https://example.invalid" })));
    await act(async () => Array.from(node.querySelectorAll("button")).find((button) => button.textContent === "Xác nhận thực hiện")!.click());
    if (kind === "evidence") expect(node.textContent?.includes("Synthetic private evidence")).toBe(true);
    else { expect(open).toHaveBeenCalledOnce(); expect(node.innerHTML.includes("https://example.invalid/synthetic-file")).toBe(false); }
  } finally { await act(async () => root.unmount()); node.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});
test.each(["order_summary", "thread_page", "resolution_records", "refund_destination", "report_context", "package_revision", "brief", "appeal_source"] as const)("OIDC evidence review scopes trust fields to %s", async (section) => {
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async (_path, init?: RequestInit) => Response.json(init?.method === "POST"
    ? { evidence: { brief: { text: "Yêu cầu gốc" }, reports: [{ reporterUserId: null, detail: "Chi tiết báo cáo gốc" }], action: { kind: "warning", explanation: "Giải thích gốc" } } }
    : { title: "Xem bằng chứng của vụ việc", body: JSON.stringify({ section }), ready: true, returnPath: "/admin/cases/synthetic", expiresAt: "2026-10-20T00:00:00.000Z" })));
  try {
    await act(async () => root.render(createElement(CommandReview, { id: "synthetic", accountPortalUrl: "https://example.invalid" })));
    await act(async () => Array.from(node.querySelectorAll("button")).find((button) => button.textContent === "Xác nhận thực hiện")!.click());
    expect(node.textContent).toContain("Yêu cầu gốc");
    const trustSection = ["report_context", "package_revision", "brief", "appeal_source"].includes(section);
    for (const text of ["Khách chưa đăng nhập", "Chi tiết báo cáo gốc", "Giải thích gốc"]) expect(node.textContent?.includes(text)).toBe(trustSection);
  } finally { await act(async () => root.unmount()); node.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});
