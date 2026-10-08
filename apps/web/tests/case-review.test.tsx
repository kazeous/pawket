// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { CommandReview } from "../src/app/auth/review/[id]/review-panel";
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
