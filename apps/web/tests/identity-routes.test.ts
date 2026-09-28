import { afterEach, describe, expect, test, vi } from "vitest";
import { metricsRegistry } from "@pawket/observability";
import { GET as legacyGet, POST as legacyPost } from "../src/app/api/auth/[...all]/route.js";
const boundary = vi.hoisted(() => ({ access: vi.fn(), session: vi.fn(async () => new Response(null, { status: 204 })), login: vi.fn(async () => Response.json({ started: true })) }));
vi.mock("../src/auth/runtime", () => ({ getIdentityRuntime: () => { boundary.access(); return { handlers: { session: boundary.session }, oidc: { login: boundary.login } }; } }));
afterEach(() => { vi.clearAllMocks(); metricsRegistry.resetMetrics(); });
describe("SSO route wiring and credential retirement", () => {
  test.each(["sign-in/email", "sign-up/email", "two-factor/verify-totp", "two-factor/enable", "link-social", "unlink-account", "callback/google", "reset-password", "get-session", "future-provider-command"])("retires %s without consuming or forwarding credentials", async (path) => {
    const request = new Request("https://pawket.example/api/auth/" + path, { method: "POST", body: "sensitive-original-body" });
    const response = await legacyPost(request);
    expect(response.status).toBe(410); expect(await response.json()).toEqual({ code: "AUTH_MOVED" });
    expect(request.bodyUsed).toBe(false); expect(response.headers.get("cache-control")).toBe("no-store"); expect(response.headers.has("location")).toBe(false);
    expect((await legacyGet(new Request("https://pawket.example/api/auth/" + path + "?token=old-secret"))).status).toBe(410);
    expect(boundary.access).not.toHaveBeenCalled(); expect(await metricsRegistry.metrics()).not.toContain("sensitive-original-body");
  });
  test("versioned registration is retired without constructing the auth runtime", async () => {
    const { POST } = await import("../src/app/api/v1/auth/register/route.js");
    const request = new Request("https://pawket.example/api/v1/auth/register", { method: "POST", body: "password=retired" });
    expect((await POST(request)).status).toBe(410); expect(request.bodyUsed).toBe(false); expect(boundary.access).not.toHaveBeenCalled();
    expect(await metricsRegistry.metrics()).toContain('pawket_auth_operations_total{operation="registration",outcome="rejected"} 1');
  });
  test("local session revocation retains its ownership-checked handler and metrics", async () => {
    const { DELETE } = await import("../src/app/api/v1/me/sessions/[sessionId]/route.js");
    const request = new Request("https://pawket.example/api/v1/me/sessions/session-safe", { method: "DELETE" });
    expect((await DELETE(request, { params: Promise.resolve({ sessionId: "session-safe" }) })).status).toBe(204);
    expect(boundary.session).toHaveBeenCalledWith(request, "session-safe");
    expect(await metricsRegistry.metrics()).toContain('pawket_auth_operations_total{operation="session",outcome="succeeded"} 1');
  });
  test("OIDC dispatch uses the allowlisted handler and rejects unknown operations", async () => {
    const { POST } = await import("../src/app/api/v1/auth/oidc/[operation]/route.js");
    const request = new Request("https://pawket.example/api/v1/auth/oidc/start", { method: "POST" });
    expect((await POST(request, { params: Promise.resolve({ operation: "start" }) })).status).toBe(200);
    expect(boundary.login).toHaveBeenCalledWith(request);
    expect((await POST(request, { params: Promise.resolve({ operation: "sign-in/email" }) })).status).toBe(404);
    expect(boundary.login).toHaveBeenCalledTimes(1);
  });
});
