import { describe, expect, test, vi } from "vitest";
import { NotificationError, type OptionalEmailCategory } from "@pawket/notifications";
import { createNotificationHttpHandlers } from "../src/platform/notification-http.js";

const origin = "https://pawket.example.invalid";
const actor = { userId: "synthetic-user", sessionId: "synthetic-session" };
const orderId = "11111111-1111-4111-8111-111111111111";
const itemId = "22222222-2222-4222-8222-222222222222";
const listed = { items: [{ id: itemId, kind: "order_completed" as const, variant: null, title: "T", body: "B", actionLabel: "A", actionRequired: false,
  linkPath: `/commissions/${orderId}`, count: 1, createdAt: "2026-10-05T03:00:00.000Z", read: false }], nextCursor: "abc" };

function fixture(options: { anonymous?: boolean; mode?: "enabled" | "disabled" } = {}) {
  const mode = options.mode ?? "enabled";
  const disabled = () => Promise.reject(new NotificationError("not_available"));
  const inbox = {
    mode,
    list: vi.fn(mode === "enabled" ? () => Promise.resolve(listed) : disabled),
    summary: vi.fn(mode === "enabled" ? () => Promise.resolve({ unread: 3 }) : disabled),
    markRead: vi.fn(mode === "enabled" ? () => Promise.resolve(1) : disabled),
    readPreferences: vi.fn(async () => ({ email: { orders: true, messages: true, deliveries: true, disputes_refunds: true, moderation: true } as Record<OptionalEmailCategory, boolean>, owner: false })),
    setPreference: vi.fn(async () => undefined),
  };
  const authenticate = vi.fn().mockResolvedValue(options.anonymous ? null : actor);
  return { inbox, authenticate, http: createNotificationHttpHandlers({ appBaseUrl: origin, authenticate, inbox }) };
}
const get = (path: string, headers: Record<string, string> = {}) => new Request(`${origin}${path}`, { method: "GET", headers });
function post(body: unknown, options: { path?: string; headers?: Record<string, string> } = {}) {
  return new Request(`${origin}${options.path ?? "/api/v1/notifications/read"}`, { method: "POST",
    headers: { origin, "content-type": "application/json", ...options.headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
}
const privateHeaders = (response: Response) => {
  for (const header of ["cache-control", "referrer-policy", "x-content-type-options"]) expect(response.headers.has(header)).toBe(true);
  expect(response.headers.get("cache-control")).toContain("no-store");
};

describe("notification HTTP", () => {
  test("401 without a session", async () => {
    const f = fixture({ anonymous: true });
    for (const response of [await f.http.list(get("/api/v1/notifications")), await f.http.summary(get("/api/v1/notifications/summary")),
      await f.http.read(post({ all: true }))]) {
      expect(response.status).toBe(401); expect(await response.json()).toEqual({ code: "unauthenticated" }); privateHeaders(response);
    }
    expect(f.inbox.list).not.toHaveBeenCalled(); expect(f.inbox.summary).not.toHaveBeenCalled(); expect(f.inbox.markRead).not.toHaveBeenCalled();
  });

  test("404 when disabled", async () => {
    for (const anonymous of [false, true]) {
      const f = fixture({ mode: "disabled", anonymous });
      for (const response of [await f.http.list(get("/api/v1/notifications")), await f.http.summary(get("/api/v1/notifications/summary")),
        await f.http.read(post({ all: true }))]) {
        expect(response.status).toBe(404); expect(await response.json()).toEqual({ code: "not_available" }); privateHeaders(response);
      }
    }
    // A service that reports itself unavailable mid-flight is also a 404.
    const f = fixture(); f.inbox.summary.mockRejectedValue(new NotificationError("not_available"));
    const response = await f.http.summary(get("/api/v1/notifications/summary"));
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ code: "not_available" });
  });

  test("list and summary return the viewer's own inbox", async () => {
    const f = fixture();
    const list = await f.http.list(get("/api/v1/notifications"));
    expect(list.status).toBe(200); expect(await list.json()).toEqual(listed); privateHeaders(list);
    expect(f.inbox.list).toHaveBeenCalledWith(actor.userId, null);
    await f.http.list(get("/api/v1/notifications?cursor=abc_-1"));
    expect(f.inbox.list).toHaveBeenLastCalledWith(actor.userId, "abc_-1");
    const summary = await f.http.summary(get("/api/v1/notifications/summary"));
    expect(summary.status).toBe(200); expect(await summary.json()).toEqual({ unread: 3 }); privateHeaders(summary);
    expect(f.inbox.summary).toHaveBeenCalledWith(actor.userId);
    // Unknown, repeated or malformed query parameters, a bad cursor and a cross-site read are refused.
    for (const path of ["/api/v1/notifications?userId=x", "/api/v1/notifications?cursor=a&cursor=b", "/api/v1/notifications?cursor=a%20b", "/api/v1/notifications?cursor="]) {
      expect((await f.http.list(get(path))).status).toBe(400);
    }
    expect((await f.http.summary(get("/api/v1/notifications/summary?x=1"))).status).toBe(400);
    f.inbox.list.mockRejectedValueOnce(new NotificationError("invalid_request"));
    expect((await f.http.list(get("/api/v1/notifications?cursor=forged"))).status).toBe(400);
    expect((await f.http.summary(get("/api/v1/notifications/summary", { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect((await f.http.summary(get("/api/v1/notifications/summary", { origin: "https://foreign.invalid" }))).status).toBe(403);
    expect((await f.http.summary(new Request(`${origin}/api/v1/notifications/summary`, { method: "POST", headers: { origin } }))).status).toBe(405);
    f.inbox.summary.mockRejectedValueOnce(new Error("database down"));
    expect((await f.http.summary(get("/api/v1/notifications/summary"))).status).toBe(503);
  });

  test("read refuses a cross-site origin, a query string and a body with two targets", async () => {
    const f = fixture();
    expect((await f.http.read(post({ all: true }, { headers: { origin: "https://foreign.invalid" } }))).status).toBe(403);
    const missingOrigin = post({ all: true }); missingOrigin.headers.delete("origin");
    expect((await f.http.read(missingOrigin)).status).toBe(403);
    expect((await f.http.read(post({ all: true }, { headers: { "sec-fetch-site": "cross-site" } }))).status).toBe(403);
    expect((await f.http.read(post({ all: true }, { path: "/api/v1/notifications/read?all=1" }))).status).toBe(400);
    for (const body of [{ all: true, orderId }, { ids: [itemId], all: true }, { ids: [itemId], orderId }, {}, { all: false }, { ids: [] },
      { ids: Array.from({ length: 31 }, () => itemId) }, { ids: ["not-a-uuid"] }, { orderId: "x" }, { orderId, userId: actor.userId }, [], null, "not json"]) {
      const response = await f.http.read(post(body)); expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect((await f.http.read(post({ all: true }, { headers: { "content-type": "text/plain" } }))).status).toBe(415);
    expect((await f.http.read(new Request(`${origin}/api/v1/notifications/read`, { method: "GET", headers: { origin } }))).status).toBe(405);
    expect(f.inbox.markRead).not.toHaveBeenCalled();
  });

  test("read returns 204", async () => {
    const f = fixture();
    for (const target of [{ all: true }, { orderId }, { ids: Array.from({ length: 30 }, () => itemId) }] as const) {
      const response = await f.http.read(post(target));
      expect(response.status).toBe(204); expect(await response.text()).toBe(""); privateHeaders(response);
      expect(f.inbox.markRead).toHaveBeenLastCalledWith(actor.userId, target);
    }
    // Marking items that are already read, or someone else's, is still a quiet 204.
    f.inbox.markRead.mockResolvedValueOnce(0);
    expect((await f.http.read(post({ ids: [itemId] }))).status).toBe(204);
  });

  test("PUT refuses unknown categories and extra keys", async () => {
    const f = fixture();
    const put = (body: unknown, suffix = "", headers: Record<string, string> = {}) => new Request(`${origin}/api/v1/notifications/preferences${suffix}`,
      { method: "PUT", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    for (const body of [{ channel: "email", category: "tips", enabled: false }, { channel: "email", category: "unknown", enabled: false },
      { channel: "discord", category: "orders", enabled: true }, { channel: "email", category: "orders", enabled: true, userId: "other" },
      { channel: "email", category: "orders", enabled: "true" }]) expect((await f.http.setPreference(put(body))).status).toBe(400);
    const valid = { channel: "email", category: "orders", enabled: false };
    expect((await f.http.setPreference(put(valid, "?x=1"))).status).toBe(400);
    expect((await f.http.setPreference(put(valid, "", { origin: "https://foreign.invalid" }))).status).toBe(403);
    expect((await f.http.setPreference(put(valid, "", { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect(f.inbox.setPreference).not.toHaveBeenCalled();
    const response = await f.http.setPreference(put(valid)); expect(response.status).toBe(204); privateHeaders(response);
    expect(f.inbox.setPreference).toHaveBeenCalledWith(actor.userId, { ...valid, at: expect.any(Date) });
    const read = await f.http.preferences(get("/api/v1/notifications/preferences")); expect(read.status).toBe(200);
    expect(await read.json()).toEqual(await f.inbox.readPreferences());
    f.inbox.setPreference.mockRejectedValueOnce(new NotificationError("invalid_request"));
    expect((await f.http.setPreference(put({ ...valid, category: "owner_queue" }))).status).toBe(400);
  });

  test("preferences are 404 when disabled and 401 when anonymous", async () => {
    for (const options of [{ mode: "disabled" as const }, { anonymous: true }]) {
      const f = fixture(options);
      const request = new Request(`${origin}/api/v1/notifications/preferences`, { method: "PUT", headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ channel: "email", category: "orders", enabled: false }) });
      const status = options.mode === "disabled" ? 404 : 401;
      expect((await f.http.preferences(get("/api/v1/notifications/preferences"))).status).toBe(status);
      expect((await f.http.setPreference(request)).status).toBe(status); expect(f.inbox.setPreference).not.toHaveBeenCalled();
    }
  });
});
