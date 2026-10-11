// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { HelpCaseView } from "@pawket/trust";

const { replace, refresh, cookies, read, runtime } = vi.hoisted(() => {
  const read = vi.fn(); return { replace: vi.fn(), refresh: vi.fn(), cookies: vi.fn(), read,
    runtime: { trustEnforcementMode: "enabled", helpCases: { read } } };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, refresh }) }));
vi.mock("next/headers", () => ({ cookies }));
vi.mock("../src/platform/runtime", () => ({ getPlatformRuntime: () => runtime }));
vi.mock("../src/ui/app-shell", () => ({ AppShell: () => { throw new Error("Locked help must not render app navigation"); } }));
import LandingPage from "../src/app/help/locked/page";
import CasePage from "../src/app/help/locked/case/page";
import ResendPage from "../src/app/help/locked/resend/page";
import { LockedCase } from "../src/ui/trust/locked-case";

const token = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
const id = "10000000-0000-4000-8000-000000000001";
const view: HelpCaseView = { penaltyId: id, kind: "suspension", state: "active", explanation: "Synthetic <explanation>",
  startsAt: "2026-10-10T00:00:00.000Z", endsAt: null, enforcementPolicyRevisionId: id, canAppeal: true, appeal: null,
  readOnlyUntil: "2027-01-08T00:00:00.000Z" };
beforeEach(() => { vi.resetAllMocks(); runtime.trustEnforcementMode = "enabled"; cookies.mockResolvedValue({ getAll: () => [] }); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); window.history.replaceState(null, "", "/help/locked"); });
afterEach(() => { vi.unstubAllGlobals(); });
async function mount(node: React.ReactNode, check: (container: HTMLDivElement) => Promise<void>) {
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try { await act(async () => root.render(node)); await check(container); }
  finally { await act(async () => root.unmount()); container.remove(); }
}
test("landing removes the fragment before posting, exchanges once in StrictMode and navigates without the token", async () => {
  window.history.replaceState(null, "", `/help/locked#t=${token}`);
  const fetch = vi.fn().mockImplementation(async () => { expect(window.location.hash).toBe(""); return new Response(null, { status: 204 }); }); vi.stubGlobal("fetch", fetch);
  await mount(createElement(StrictMode, null, createElement(LandingPage)), async (container) => {
    expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0]).toEqual(["/help/locked/session", expect.objectContaining({ method: "POST", body: JSON.stringify({ token }), credentials: "same-origin", cache: "no-store" })]);
    expect(replace).toHaveBeenCalledWith("/help/locked/case"); expect(container.textContent).not.toContain(token);
  });
});
test.each(["missing", "malformed", "refused", "network"])("landing shows the expired-link state for %s", async (failure) => {
  if (failure !== "missing") window.history.replaceState(null, "", failure === "malformed" ? "/help/locked#t=bad&t=other" : `/help/locked#t=${token}`);
  const fetch = vi.fn().mockImplementation(async () => { if (failure === "network") throw new Error("private dependency"); return new Response(null, { status: 400 }); }); vi.stubGlobal("fetch", fetch);
  await mount(createElement(LandingPage), async (container) => {
    expect(container.textContent).toContain("Liên kết không còn hiệu lực."); expect(container.querySelector('a[href="/help/locked/resend"]')).not.toBeNull();
    expect(window.location.hash).toBe(""); expect(replace).not.toHaveBeenCalled();
    if (["missing", "malformed"].includes(failure)) expect(fetch).not.toHaveBeenCalled();
  });
});
test("case page without a cookie shows the expired-link state without a private read", async () => {
  const markup = renderToStaticMarkup(await CasePage()); expect(markup).toContain("Liên kết không còn hiệu lực."); expect(read).not.toHaveBeenCalled();
});
test.each(["disabled", "expired", "duplicate-cookie", "unavailable"])("case page refuses %s with the same state", async (state) => {
  cookies.mockResolvedValue({ getAll: () => state === "duplicate-cookie" ? [{ value: token }, { value: token }] : [{ value: token }] });
  runtime.trustEnforcementMode = state === "disabled" ? "disabled" : "enabled";
  if (state === "unavailable") read.mockRejectedValue(new Error("must not render")); else read.mockResolvedValue(null);
  expect(renderToStaticMarkup(await CasePage())).toContain("Liên kết không còn hiệu lực.");
  if (["disabled", "duplicate-cookie"].includes(state)) expect(read).not.toHaveBeenCalled();
});
test.each([false, true])("case page shows appeal form only while canAppeal=%s", async (canAppeal) => {
  cookies.mockResolvedValue({ getAll: () => [{ value: token }] }); read.mockResolvedValue({ ...view, canAppeal });
  const markup = renderToStaticMarkup(await CasePage()); expect(read).toHaveBeenCalledWith(token);
  expect(markup.includes('aria-label="Gửi kháng nghị"')).toBe(canAppeal); expect(markup).toContain("Synthetic &lt;explanation&gt;");
  expect(markup).toContain(`/help/policies/${id}`); expect(markup).toContain('action="/help/locked/end"'); expect(markup).toContain("Kết thúc phiên");
  expect(markup).not.toContain(token); expect(markup).not.toContain("Đăng nhập"); expect(markup).not.toContain("<nav");
});
test("an existing appeal hides the form and shows status and decided reasoning", () => {
  const markup = renderToStaticMarkup(createElement(LockedCase, { view: { ...view, appeal: { state: "upheld", reasoning: "Synthetic <decision>", decidedAt: view.startsAt } } }));
  expect(markup).not.toContain('aria-label="Gửi kháng nghị"'); expect(markup).toContain("Giữ nguyên biện pháp"); expect(markup).toContain("Synthetic &lt;decision&gt;");
  expect(renderToStaticMarkup(createElement(LockedCase, { view: { ...view, appeal: { state: "open", reasoning: "private-pending-reason", decidedAt: null } } }))).not.toContain("private-pending-reason");
});
test("locked appeal uses the help cookie endpoint without app identity polling and refreshes after success", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ appealId: id }), { status: 202, headers: { "content-type": "application/json" } })); vi.stubGlobal("fetch", fetch);
  await mount(createElement(LockedCase, { view }), async (container) => {
    expect(fetch).not.toHaveBeenCalled(); const form = container.querySelector('form[aria-label="Gửi kháng nghị"]')!;
    form.querySelector("textarea")!.value = "Synthetic appeal";
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0]![0]).toBe("/help/locked/appeal");
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ target: { penaltyId: id }, statement: "Synthetic appeal" });
    expect(fetch.mock.calls[0]![1].headers["idempotency-key"]).toEqual(expect.any(String)); expect(refresh).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Đã gửi kháng nghị. Pawket đang xem xét.");
  });
});
test.each(["unknown", "active", "locked"])("resend shows the same confirmation for %s email", async (kind) => {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 })); vi.stubGlobal("fetch", fetch);
  await mount(await ResendPage(), async (container) => {
    const input = container.querySelector<HTMLInputElement>('input[type="email"]')!; input.value = `${kind}@example.invalid`;
    expect(container.querySelectorAll("input")).toHaveLength(1); expect(container.querySelector("label")?.htmlFor).toBe(input.id);
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(fetch.mock.calls[0]![0]).toBe("/help/locked/link-request"); expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ email: input.value });
    expect(container.textContent).toContain("Nếu email này thuộc một tài khoản đang bị khóa, Pawket đã gửi liên kết mới."); expect(container.textContent).not.toContain(input.value);
  });
});
test("resend page is expired while enforcement is disabled", async () => {
  runtime.trustEnforcementMode = "disabled";
  const markup = renderToStaticMarkup(await ResendPage()); expect(markup).toContain("Liên kết không còn hiệu lực."); expect(markup).not.toContain("<form");
});
test.each(["refused", "network"])("resend keeps the approved confirmation for a %s failure", async (failure) => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => { if (failure === "network") throw new Error("private dependency"); return new Response(null, { status: 400 }); }));
  await mount(await ResendPage(), async (container) => {
    container.querySelector<HTMLInputElement>('input[type="email"]')!.value = "synthetic@example.invalid";
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(container.textContent).toContain("Nếu email này thuộc một tài khoản đang bị khóa, Pawket đã gửi liên kết mới.");
    expect(container.textContent).not.toContain("private dependency");
  });
});
test("an expired help session offers a fresh link without the app sign-in flow", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "authentication_required" }), { status: 401, headers: { "content-type": "application/json" } })));
  await mount(createElement(LockedCase, { view }), async (container) => {
    const form = container.querySelector('form[aria-label="Gửi kháng nghị"]')!; form.querySelector("textarea")!.value = "Synthetic appeal";
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(container.textContent).toContain("Liên kết không còn hiệu lực."); expect(container.querySelector('a[href="/help/locked/resend"]')).not.toBeNull();
    expect(container.querySelector('a[href="/sign-in"]')).toBeNull(); expect(refresh).not.toHaveBeenCalled();
  });
});
