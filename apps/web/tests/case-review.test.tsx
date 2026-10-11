// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { CommandReview } from "../src/app/auth/review/[id]/review-panel";
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
