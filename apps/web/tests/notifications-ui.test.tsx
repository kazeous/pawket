// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const { push, platform } = vi.hoisted(() => ({ push: vi.fn(), platform: {
  notifications: { mode: "enabled", list: vi.fn(), readPreferences: vi.fn() }, authenticate: vi.fn(),
} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), notFound: () => { throw new Error("NOT_FOUND"); }, redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); } }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("../src/platform/runtime", () => ({ getPlatformRuntime: () => platform }));
vi.mock("../src/ui/app-shell", () => ({ AppShell: ({ children }: { children: ReactNode }) => children }));
import { NotificationBell } from "../src/ui/notifications/notification-bell";
import { NotificationInbox } from "../src/ui/notifications/notification-inbox";
import NotificationsPage from "../src/app/notifications/page";
import { NotificationPreferences } from "../src/ui/notifications/notification-preferences";
import NotificationSettingsPage from "../src/app/settings/notifications/page";

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
test("preferences show informational switches, always-on rows and save one category at a time", async () => {
  fetch.mockResolvedValue(new Response(null, { status: 204 }));
  await mount(<NotificationPreferences initial={{ owner: false, email: { orders: true, messages: true, deliveries: true, disputes_refunds: true, moderation: true } }} />);
  expect(container.querySelectorAll('[role="switch"]')).toHaveLength(5);
  expect(container.textContent).not.toContain("Hàng đợi xử lý");
  expect(container.textContent).toContain("Luôn bật"); expect(container.textContent).toContain("Thông báo trong ứng dụng luôn nhận đầy đủ");
  const orders = container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Email về đơn commission"]')!;
  await act(async () => orders.click());
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ channel: "email", category: "orders", enabled: false });
  expect(orders.getAttribute("aria-checked")).toBe("false");
  fetch.mockResolvedValueOnce(new Response(null, { status: 503 })); await act(async () => orders.click());
  expect(orders.getAttribute("aria-checked")).toBe("false"); expect(container.querySelector('[role="alert"]')).not.toBeNull();
});
test("settings page is gated and shows the owner queue only with an active owner grant", async () => {
  platform.notifications.mode = "disabled";
  await expect(NotificationSettingsPage()).rejects.toThrow("NOT_FOUND"); expect(platform.authenticate).not.toHaveBeenCalled();
  platform.notifications.mode = "enabled"; platform.authenticate.mockResolvedValue(null);
  await expect(NotificationSettingsPage()).rejects.toThrow("REDIRECT:/sign-in?returnTo=/settings/notifications");
  platform.authenticate.mockResolvedValue({ userId: "viewer" });
  platform.notifications.readPreferences.mockResolvedValue({ owner: true, email: { orders: true, messages: true, deliveries: true, disputes_refunds: true, moderation: true, owner_queue: true } });
  await mount(await NotificationSettingsPage()); expect(container.querySelectorAll('[role="switch"]')).toHaveLength(6);
  expect(platform.notifications.readPreferences).toHaveBeenCalledWith("viewer"); expect(container.textContent).toContain("Hàng đợi xử lý");
});
