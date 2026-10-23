// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const { push, platform } = vi.hoisted(() => ({ push: vi.fn(), platform: {
  notifications: { mode: "enabled", list: vi.fn() }, authenticate: vi.fn(),
} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), notFound: () => { throw new Error("NOT_FOUND"); }, redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); } }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("../src/platform/runtime", () => ({ getPlatformRuntime: () => platform }));
vi.mock("../src/ui/app-shell", () => ({ AppShell: ({ children }: { children: ReactNode }) => children }));
import { NotificationBell } from "../src/ui/notifications/notification-bell";
import { NotificationInbox } from "../src/ui/notifications/notification-inbox";
import NotificationsPage from "../src/app/notifications/page";

const id = "10000000-0000-4000-8000-000000000001";
const item = { id, kind: "order_completed" as const, variant: null, title: "Đơn đã hoàn tất", body: "Bạn có thể xem lại lịch sử đơn.", actionLabel: "Xem đơn",
  actionRequired: true, linkPath: `/commissions/${id}`, count: 1, createdAt: "2026-10-12T00:00:00.000Z", read: false };
let container: HTMLDivElement; let root: Root; let fetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); push.mockReset();
  platform.notifications.mode = "enabled"; platform.authenticate.mockReset().mockResolvedValue({ userId: "viewer" });
  platform.notifications.list.mockReset().mockResolvedValue({ items: [item], nextCursor: null });
  fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function mount(node: ReactNode) { await act(async () => root.render(node)); }

test("bell fetches once on mount, uses the unread label and shows 99+ at the cap", async () => {
  fetch.mockResolvedValue(Response.json({ unread: 99 }));
  await mount(<NotificationBell />);
  expect(container.querySelector('a[href="/notifications"]')?.getAttribute("aria-label")).toBe("Thông báo, 99 chưa đọc");
  expect(container.textContent).toContain("99+");
  await mount(<NotificationBell />); expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]![0]).toBe("/api/v1/notifications/summary");
});
test.each([404, 503, 200])("bell is hidden on errors or invalid data (%s)", async (status) => {
  fetch.mockResolvedValue(Response.json({ unread: "unsafe" }, { status }));
  await mount(<NotificationBell />); expect(container.innerHTML).toBe("");
});
test("inbox marks one item before navigating and can mark all read", async () => {
  fetch.mockImplementation(async () => new Response(null, { status: 204 }));
  await mount(<NotificationInbox initial={{ items: [item], nextCursor: null }} />);
  expect(container.textContent).toContain("Cần bạn xử lý");
  expect(container.querySelector('a[href="/settings/notifications"]')).not.toBeNull();
  await act(async () => container.querySelector<HTMLAnchorElement>(`a[href="${item.linkPath}"]`)!.click());
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ ids: [id] }); expect(push).toHaveBeenCalledWith(item.linkPath);
  await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Đánh dấu tất cả là đã đọc")!.click());
  expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ all: true });
  expect(container.querySelector('[data-unread="true"]')).toBeNull();
});
test("inbox loads the next page and preserves existing items on a read failure", async () => {
  fetch.mockResolvedValueOnce(Response.json({ items: [{ ...item, id: id.slice(0, -1) + "2", read: true }], nextCursor: null }));
  await mount(<NotificationInbox initial={{ items: [item], nextCursor: "abc_-" }} />);
  await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Xem thêm")!.click());
  expect(fetch.mock.calls[0]![0]).toBe("/api/v1/notifications?cursor=abc_-"); expect(container.querySelectorAll("li")).toHaveLength(2);
  fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
  await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Đánh dấu tất cả là đã đọc")!.click());
  expect(container.querySelector('[data-unread="true"]')).not.toBeNull(); expect(container.querySelector('[role="alert"]')).not.toBeNull();
});
test("notification page is unavailable while disabled, redirects anonymous users and loads only the viewer's inbox", async () => {
  platform.notifications.mode = "disabled";
  await expect(NotificationsPage()).rejects.toThrow("NOT_FOUND"); expect(platform.authenticate).not.toHaveBeenCalled();
  platform.notifications.mode = "enabled"; platform.authenticate.mockResolvedValue(null);
  await expect(NotificationsPage()).rejects.toThrow("REDIRECT:/sign-in?returnTo=/notifications");
  platform.authenticate.mockResolvedValue({ userId: "viewer" });
  await mount(await NotificationsPage()); expect(platform.notifications.list).toHaveBeenCalledWith("viewer", null); expect(container.textContent).toContain(item.title);
});
