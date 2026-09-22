import { describe, expect, test, vi } from "vitest";
import { CreatorTipSettingsError } from "@pawket/catalog";
import { createCreatorTipSettingsHttpHandlers } from "../src/creator-tip-settings-http.js";

const actor = { userId: "creator-session-owner", sessionId: "current-session", primaryAuthenticatedAt: new Date() };
const settings = { revisionId: null, revisionNumber: 0, enabled: false, minimumVnd: 10_000, maximumVnd: 5_000_000, presetsVnd: [20_000, 50_000, 100_000], available: true, platformPolicyRevisionId: null, effectivePolicy: { revisionId: "00000000-0000-4000-8000-000000000001", revisionNumber: 1, minimumVnd: 10_000, maximumVnd: 5_000_000, allowedPresetsVnd: [20_000, 50_000, 100_000], effectiveAt: "2026-09-22T00:00:00.000Z" }, effectivePresetsVnd: [20_000, 50_000, 100_000], presetsFallback: false };
const body = { expectedRevision: 0, expectedPolicyRevision: 1, enabled: true, presetsVnd: settings.presetsVnd };
function setup(overrides: Partial<Parameters<typeof createCreatorTipSettingsHttpHandlers>[0]> = {}) {
  const { available: _available, ...saved } = settings; void _available;
  const service = { getOwnSettings: vi.fn(async () => settings), saveOwnSettings: vi.fn(async () => saved) };
  const authenticate = vi.fn(async (): Promise<typeof actor | null> => actor); const throttle = vi.fn(async () => true);
  const handlers = createCreatorTipSettingsHttpHandlers({ appBaseUrl: "https://pawket.test", paymentsMode: "manual_only", publishingMode: "general_audience", lookupHmacKey: new Uint8Array(32).fill(48), service, authenticate, throttle, ...overrides });
  return { handlers, service, authenticate, throttle };
}
function request(init: RequestInit = {}, query = "") {
  const method = init.method ?? "POST";
  return new Request(`https://pawket.test/api/v1/creator/tip-settings${query}`, { method, ...(method === "POST" ? { body: JSON.stringify(body) } : {}), ...init,
    headers: { origin: "https://pawket.test", "content-type": "application/json", "idempotency-key": "settings-command", "x-real-ip": "192.0.2.4", ...Object.fromEntries(new Headers(init.headers)) } });
}
describe("creator tip settings HTTP ownership and privacy", () => {
  test("binds reads and commands to the server session with no caller-selected page", async () => {
    const s = setup();
    const response = await s.handlers.save(request()); expect(response.status).toBe(200);
    expect(s.service.saveOwnSettings).toHaveBeenCalledWith({ ...body, actor, idempotencyKey: "settings-command", requestId: expect.any(String) });
    expect(response.headers.get("cache-control")).toContain("no-store"); expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect((await s.handlers.read(request({ method: "GET" }))).status).toBe(200); expect(s.service.getOwnSettings).toHaveBeenCalledWith(actor.userId);
    expect(JSON.stringify(s.throttle.mock.calls)).not.toContain("192.0.2.4");
  });
  test.each(["actor", "pageId", "creatorUserId", "primaryAuthenticatedAt", "minimumVnd", "maximumVnd"])("rejects caller authority and policy fields: %s", async (field) => {
    const s = setup(); expect((await s.handlers.save(request({ body: JSON.stringify({ ...body, [field]: "forged" }) }))).status).toBe(400);
    expect(s.service.saveOwnSettings).not.toHaveBeenCalled();
  });
  test("requires authentication, trusted origin and rate admission before mutations", async () => {
    const s = setup(); s.authenticate.mockResolvedValueOnce(null); expect((await s.handlers.save(request())).status).toBe(401);
    expect((await s.handlers.save(request({ headers: { origin: "https://evil.test" } }))).status).toBe(403);
    expect((await s.handlers.read(request({ method: "GET", headers: { "sec-fetch-site": "cross-site" } }))).status).toBe(403);
    s.throttle.mockResolvedValueOnce(false); expect((await s.handlers.save(request())).status).toBe(429);
    expect((await s.handlers.save(request({ headers: { "x-real-ip": "" } }))).status).toBe(503); expect(s.service.saveOwnSettings).not.toHaveBeenCalled();
  });
  test("keeps disabled-mode reads while preventing writes for either global mode", async () => {
    for (const mode of [{ paymentsMode: "disabled" as const }, { publishingMode: "disabled" as const }]) {
      const s = setup(mode); expect((await s.handlers.read(request({ method: "GET" }))).status).toBe(200);
      expect((await s.handlers.save(request())).status).toBe(503); expect(s.service.saveOwnSettings).not.toHaveBeenCalled();
    }
  });
  test.each([
    [{ ...body, expectedPolicyRevision: 0 }, 400], [{ ...body, expectedPolicyRevision: "1" }, 400], [{ ...body, expectedPolicyRevision: undefined }, 400],
    [{ ...body, expectedRevision: "0" }, 400], [{ ...body, enabled: "true" }, 400], [{ ...body, presetsVnd: [1, 2] }, 400],
    [{ ...body, expectedRevision: -1 }, 400], [{ ...body, presetsVnd: [20_000, 50_000, "100000"] }, 400],
  ])("rejects malformed settings command %#", async (value, status) => { const s = setup(); expect((await s.handlers.save(request({ body: JSON.stringify(value) }))).status).toBe(status); expect(s.service.saveOwnSettings).not.toHaveBeenCalled(); });
  test("bounds body, query and command key, with stable errors on dependencies", async () => {
    const s = setup();
    expect((await s.handlers.save(request({ body: "x".repeat(4097) }))).status).toBe(413);
    expect((await s.handlers.save(request({ headers: { "content-type": "text/plain" } }))).status).toBe(415);
    expect((await s.handlers.save(request({ headers: { "idempotency-key": "short" } }))).status).toBe(400);
    expect((await s.handlers.read(request({ method: "GET" }, "?pageId=another"))).status).toBe(400);
    s.service.saveOwnSettings.mockRejectedValueOnce(new CreatorTipSettingsError("RECENT_AUTH_REQUIRED"));
    const recent = await s.handlers.save(request()); expect(recent.status).toBe(403); expect(await recent.json()).toEqual({ code: "recent_auth_required" });
    s.service.saveOwnSettings.mockRejectedValueOnce(new CreatorTipSettingsError("POLICY_CHANGED"));
    const conflict = await s.handlers.save(request()); expect(conflict.status).toBe(409); expect(await conflict.json()).toEqual({ code: "policy_changed" });
    s.service.saveOwnSettings.mockRejectedValueOnce(new Error("private database failure"));
    const failed = await s.handlers.save(request()); expect(failed.status).toBe(503); expect(await failed.text()).not.toContain("private database failure");
  });
  test("rejects expanded, accessor and inconsistent dependency projections without leaking fields", async () => {
    const getter = vi.fn(() => "private secret");
    const accessor = Object.defineProperty({ ...settings }, "minimumVnd", { enumerable: true, get: getter });
    for (const malformed of [
      { ...settings, privateReason: "private secret" }, accessor,
      { ...settings, effectivePolicy: { ...settings.effectivePolicy, privateReason: "private secret" } },
      { ...settings, effectivePresetsVnd: [100_000, 50_000, 20_000] },
      { ...settings, presetsFallback: true }, { ...settings, revisionNumber: 1 },
    ]) {
      const s = setup(); s.service.getOwnSettings.mockResolvedValueOnce(malformed);
      const response = await s.handlers.read(request({ method: "GET" }));
      expect(response.status).toBe(503); expect(await response.json()).toEqual({ code: "dependency_unavailable" });
    }
    expect(getter).not.toHaveBeenCalled();
    const s = setup();
    s.service.saveOwnSettings.mockResolvedValueOnce({ ...settings });
    const response = await s.handlers.save(request());
    expect(response.status).toBe(503);
  });
});
