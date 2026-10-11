// @vitest-environment jsdom
import { act, cloneElement, isValidElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const { env, platform, solve } = vi.hoisted(() => ({
  env: { APP_BASE_URL: "https://pawket.invalid", COMMISSION_INTAKE_MODE: "enabled", TRUST_ENFORCEMENT_MODE: "enabled", CREATOR_PUBLISHING_MODE: "enabled" },
  platform: { authenticate: vi.fn(), authorizeCreator: vi.fn(), isOwnCommissionPackage: vi.fn(),
    commissionHandlers: { publicPackages: vi.fn() }, resolutionHandlers: { myCases: vi.fn() }, catalog: { initialize: vi.fn() } },
  solve: vi.fn().mockResolvedValue(1234),
}));
vi.mock("@pawket/config", () => ({ loadServerEnv: () => env }));
vi.mock("../src/platform/runtime", () => ({ getPlatformRuntime: () => platform }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), redirect: vi.fn(), notFound: vi.fn() }));
vi.mock("../src/ui/app-shell", () => ({ AppShell: ({ children }: { children: ReactNode }) => children }));
vi.mock("../src/app/creator/creator-page-workbench", () => ({ CreatorPageWorkbench: () => null }));
vi.mock("../src/app/creators/[handle]/report-proof", () => ({ solveReportChallenge: solve }));
vi.mock("../src/ui/commissions/reference-files", () => ({ ReferenceFilePicker: () => null }));
import CreatorShellPage from "../src/app/creator/page";
import { PublicCommissionPackages } from "../src/ui/commissions/commission-pages";
import { CommissionSession } from "../src/ui/commissions/commission-session";
import { CommissionRequest } from "../src/ui/commissions/commission-request";
import { ReportDialog } from "../src/ui/trust/report-dialog";
import type { PublicPackage } from "../src/ui/commissions/commission-client";
import type { PenaltyView } from "../src/ui/trust/trust-client";

const id = "10000000-0000-4000-8000-000000000001";
const actor = { userId: "synthetic-actor", sessionId: "synthetic-session" };
const offering: PublicPackage = { id, revisionId: id, title: "Synthetic package", description: "Description", discipline: "illustration", route: "custom_quote",
  briefInstructions: "Instructions", terms: null, showcaseId: null, policy: { revisionId: id, checksum: "synthetic", document: null }, accepting: true, capacityAvailable: true };
const warning: PenaltyView = { penaltyId: id, kind: "warning", restriction: null, target: null, reasonCategoryLabel: "Spam", explanation: "Warning explanation",
  startsAt: "2026-10-10T00:00:00.000Z", endsAt: null, endedAt: null, acknowledgedAt: null, state: "active", canAppeal: false, appealDeadline: null, appealState: null };

// Resolve only server components; client hooks and effects run through React normally.
async function serverTree(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(serverTree));
  if (!isValidElement<{ children?: ReactNode }>(node)) return node;
  if (typeof node.type === "function" && node.type.constructor.name === "AsyncFunction") return serverTree(await Reflect.apply(node.type, undefined, [node.props]));
  const children = await serverTree(node.props.children);
  return Array.isArray(children) ? cloneElement(node, {}, ...children) : cloneElement(node, {}, children);
}
let container: HTMLDivElement; let root: Root; let fetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  env.CREATOR_PUBLISHING_MODE = "enabled";
  platform.authenticate.mockReset().mockResolvedValue(actor); platform.authorizeCreator.mockResolvedValue("authorized");
  platform.isOwnCommissionPackage.mockReset().mockResolvedValue(false); platform.catalog.initialize.mockResolvedValue({});
  platform.commissionHandlers.publicPackages.mockImplementation(async () => Response.json({ packages: [1, 2, 3].map((n) => ({ ...offering, id: id.slice(0, -1) + n })) }));
  platform.resolutionHandlers.myCases.mockImplementation(async () => Response.json({ controls: { trustMode: "enabled" }, cases: { disputes: [], refunds: [], lateClaims: [], penalties: [], hides: [], appeals: [], reportsFiled: [] } }));
  fetch = vi.fn(async () => Response.json({ user: { id: actor.userId } })); vi.stubGlobal("fetch", fetch);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function mount(node: ReactNode) { const tree = await serverTree(node); await act(async () => root.render(tree)); }
async function openReport() {
  await act(async () => Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Báo cáo")!.click());
  return document.querySelector<HTMLDivElement>('[role="alertdialog"]')!;
}
async function submitReport(dialog: HTMLDivElement) { await act(async () => dialog.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); }

test("several public packages mount no session alerts or report polling, including focus and 30 seconds", async () => {
  vi.useFakeTimers();
  const tree = await serverTree(await PublicCommissionPackages({ handle: "artist" }));
  expect(renderToStaticMarkup(tree)).not.toContain("Đang kiểm tra phiên đăng nhập…");
  await mount(tree);
  expect(container.querySelectorAll("button")).toHaveLength(3);
  expect(container.textContent).not.toContain("Đang kiểm tra phiên đăng nhập…"); expect(container.querySelector('[role="alert"]')).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
  expect(fetch).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
test.each(["enabled", "disabled"])("creator publishing %s without warnings has no session alert or polling", async (mode) => {
  env.CREATOR_PUBLISHING_MODE = mode;
  const tree = await serverTree(await CreatorShellPage());
  expect(renderToStaticMarkup(tree)).not.toContain("Đang kiểm tra phiên đăng nhập…");
  await mount(tree);
  expect(container.textContent).not.toContain("Đang kiểm tra phiên đăng nhập…"); expect(container.querySelector('[role="alert"]')).toBeNull(); expect(fetch).not.toHaveBeenCalled();
});
test("identity failure preserves public packages and degrades to the guest report flow", async () => {
  platform.authenticate.mockRejectedValue(new Error("Identity unavailable"));
  await mount(await PublicCommissionPackages({ handle: "artist" }));
  expect(container.textContent).toContain(offering.title);
  fetch.mockImplementation(async (path: string) => Response.json(path.endsWith("challenge") ? { token: "synthetic-proof", difficulty: 18 } : { accepted: true, reportReference: "report:synthetic" }));
  const dialog = await openReport(); await submitReport(dialog);
  expect(fetch.mock.calls.map((call) => call[0])).toEqual(["/api/v1/reports/challenge", "/api/v1/reports"]);
});
test("own public packages do not offer reporting", async () => {
  platform.isOwnCommissionPackage.mockResolvedValue(true);
  await mount(await PublicCommissionPackages({ handle: "artist" }));
  expect(container.textContent).toContain(offering.title); expect(container.textContent).not.toContain("Báo cáo"); expect(fetch).not.toHaveBeenCalled();
});
test.each(["authentication_required", "AUTHENTICATION_REQUIRED", "not_authorized"])("public authenticated report shows sign-in in the dialog after %s and retries the same request", async (code) => {
  await mount(await PublicCommissionPackages({ handle: "artist" })); fetch.mockClear();
  fetch.mockImplementation(async () => Response.json({ code }, { status: 401 }));
  const dialog = await openReport(); await submitReport(dialog);
  expect(fetch.mock.calls[0]![0]).toBe("/api/v1/reports"); expect(fetch.mock.calls).toHaveLength(1);
  expect(fetch.mock.calls[0]![1]).toMatchObject({ credentials: "same-origin", headers: expect.objectContaining({ "x-pawket-actor": actor.userId }) });
  expect(dialog.querySelector('a[href="/sign-in"]')?.textContent).toBe("Đăng nhập lại trong tab mới");
  fetch.mockImplementation(async () => Response.json({ accepted: true, reportReference: "report:synthetic" }));
  await act(async () => Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent === "Kiểm tra lại cùng yêu cầu")!.click());
  expect(fetch.mock.calls[1]![1].body).toBe(fetch.mock.calls[0]![1].body);
  expect(fetch.mock.calls[1]![1].headers["idempotency-key"]).toBe(fetch.mock.calls[0]![1].headers["idempotency-key"]);
  expect(dialog.textContent).toContain("Đã gửi báo cáo.");
});
test("creator warning acknowledges without a new session boundary", async () => {
  platform.resolutionHandlers.myCases.mockImplementation(async () => Response.json({ controls: { trustMode: "enabled" }, cases: { disputes: [], refunds: [], lateClaims: [], penalties: [warning] } }));
  await mount(await CreatorShellPage()); expect(fetch).not.toHaveBeenCalled();
  fetch.mockImplementation(async () => Response.json({ acknowledged: true }));
  await act(async () => Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Tôi đã hiểu")!.click());
  expect(fetch.mock.calls[0]![0]).toBe(`/api/v1/help/warnings/${id}/acknowledge`); expect(fetch.mock.calls).toHaveLength(1);
  expect(fetch.mock.calls[0]![1].headers["x-pawket-actor"]).toBe(actor.userId);
  expect(container.textContent).not.toContain("Tài khoản của bạn đã nhận một cảnh cáo.");
});
test("trust feedback keeps its own invalid_request copy", async () => {
  await mount(await PublicCommissionPackages({ handle: "artist" }));
  fetch.mockImplementation(async () => Response.json({ code: "invalid_request" }, { status: 400 }));
  const dialog = await openReport(); await submitReport(dialog);
  expect(dialog.textContent).toContain("Kiểm tra nội dung và giới hạn ký tự trước khi gửi.");
  expect(dialog.textContent).not.toContain("Dữ liệu chưa hợp lệ.");
});
test("a trust action reuses the existing page session without mounting another polling boundary", async () => {
  const interval = vi.spyOn(globalThis, "setInterval");
  await mount(<CommissionSession actorUserId={actor.userId}><ReportDialog
    mode="enabled" target={{ kind: "commission_package", packageId: id, revisionId: id }} /></CommissionSession>);
  expect(fetch.mock.calls.map((call) => call[0])).toEqual(["/api/v1/me"]);
  fetch.mockImplementation(async (path: string) => Response.json(path === "/api/v1/me" ? { user: { id: actor.userId } } : { accepted: true, reportReference: "report:synthetic" }));
  const dialog = await openReport(); await submitReport(dialog);
  expect(fetch.mock.calls.map((call) => call[0])).toEqual(["/api/v1/me", "/api/v1/me", "/api/v1/reports", "/api/v1/me"]);
  expect(interval.mock.calls.filter((call) => call[1] === 30_000)).toHaveLength(1);
  expect(dialog.textContent).toContain("Đã gửi báo cáo.");
});
test("a commission request form retains its original invalid_request feedback", async () => {
  await mount(<CommissionSession actorUserId={actor.userId}><CommissionRequest offering={offering} /></CommissionSession>);
  container.querySelector<HTMLTextAreaElement>('[name="brief"]')!.value = "Synthetic brief";
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  fetch.mockImplementation(async (path: string) => path === "/api/v1/me" ? Response.json({ user: { id: actor.userId } }) : Response.json({ code: "invalid_request" }, { status: 400 }));
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(container.textContent).toContain("Dữ liệu chưa hợp lệ. Kiểm tra các trường và giới hạn nội dung.");
});
