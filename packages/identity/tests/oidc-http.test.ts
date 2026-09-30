import { describe, expect, test, vi } from "vitest";
import { createOidcHttpHandlers, readOpaqueCookie } from "../src/oidc-http.js";
import { OidcIdentityError } from "../src/oidc-policy.js";
import type { createOidcIdentityService } from "../src/oidc-service.js";

const origin = "https://pawket.example";
const state = "state".repeat(10); const binding = "b".repeat(43); const session = "s".repeat(43);
function harness() {
  const service: ReturnType<typeof createOidcIdentityService> = {
    authenticate: vi.fn(async () => ({ userId: "user", sessionId: "session", authorizationVersion: 1, subject: "subject",
      primaryAuthenticatedAt: new Date(), mfaVerifiedAt: null, totpStatus: "not_enrolled", sessionExpiresAt: new Date(Date.now() + 600_000),
      idpValidUntil: new Date(), leaseRequired: true, owner: false })),
    ownerLinkIntent: vi.fn(async () => ({ purpose: "owner_link" as const, userId: "owner", subject: "owner-sub", authorizationVersion: 2 })),
    begin: vi.fn(async () => ({ authorizationUrl: "https://idp.example/authorize?state=synthetic", state, browserBinding: binding })),
    callback: vi.fn(async () => ({ sessionToken: session, expiresAt: new Date("2026-09-28T00:00:00Z"), returnPath: "/settings/security" })),
    backchannelLogout: vi.fn(async () => undefined), expireTransactions: vi.fn(async () => 0),
  };
  const throttle = vi.fn(async () => true);
  const handlers = createOidcHttpHandlers({ baseURL: origin, service, throttle, now: () => new Date("2026-09-27T00:00:00Z") });
  const post = (payload: unknown, headers: Record<string, string> = {}) => new Request(`${origin}/start`, {
    method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(payload),
  });
  return { service, throttle, handlers, post };
}
describe("OIDC HTTP boundary", () => {
  test("login starts only with same-origin POST and creates a host-only HttpOnly binding cookie", async () => {
    const h = harness(); const response = await h.handlers.login(h.post({ returnPath: "/settings" }));
    expect(response.status).toBe(200); expect(await response.json()).toHaveProperty("authorizationUrl");
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^__Host-pawket\.oidc\.[a-f0-9]{24}=/u);
    expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("Secure"); expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Domain="); expect(cookie).not.toContain(state);
  });
  test("rejects foreign or missing Origin, oversized bodies and unsupported methods before begin", async () => {
    const h = harness();
    expect((await h.handlers.login(h.post({}, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await h.handlers.login(new Request(`${origin}/start`))).status).toBe(405);
    const noOrigin = h.post({}); noOrigin.headers.delete("origin");
    expect((await h.handlers.login(noOrigin)).status).toBe(403);
    expect((await h.handlers.login(h.post({ returnPath: "x".repeat(5000) }, { "content-length": "0" }))).status).toBe(400);
    expect(h.service.begin).not.toHaveBeenCalled();
  });
  test("client-supplied user, subject and intent never override the server actor", async () => {
    const h = harness(); const request = h.post({ purpose: "owner_link", actor: { userId: "attacker" }, returnPath: "/settings" }, { cookie: `__Host-pawket.session=${session}` });
    await h.handlers.lease(request);
    expect(h.service.begin).toHaveBeenCalledWith(expect.objectContaining({ intent: expect.objectContaining({ purpose: "lease_check", actor: expect.objectContaining({ userId: "user" }) }) }));
    await h.handlers.login(h.post({ purpose: "owner_link", userId: "attacker" }));
    expect(h.service.begin).toHaveBeenLastCalledWith({ intent: { purpose: "login" }, returnPath: "/" });
  });
  test("callback requires matching browser cookie, clears it, and redirects without OAuth parameters", async () => {
    const h = harness(); const started = await h.handlers.login(h.post({}));
    const browserCookie = started.headers.get("set-cookie")!.split(";")[0]!;
    const response = await h.handlers.callback(new Request(`${origin}/callback?state=${state}&code=sensitive-code`, {
      headers: { cookie: `${browserCookie}; __Host-pawket.session=${session}` },
    }));
    expect(response.status).toBe(303); expect(response.headers.get("location")).toBe(`${origin}/settings/security`);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("set-cookie")).toContain(`__Host-pawket.session=${session}`);
    expect(response.headers.get("location")).not.toContain("sensitive-code");
  });
  test("missing or duplicated browser binding never reaches exchange", async () => {
    const h = harness(); const started = await h.handlers.login(h.post({}));
    const c = started.headers.get("set-cookie")!.split(";")[0]!;
    await h.handlers.callback(new Request(`${origin}/callback?state=${state}&code=secret`));
    await h.handlers.callback(new Request(`${origin}/callback?state=${state}&code=secret`, { headers: { cookie: `${c}; ${c}` } }));
    await h.handlers.callback(new Request(`${origin}/callback?state=${state}&state=${state}&code=secret`, { headers: { cookie: c } }));
    expect(h.service.callback).not.toHaveBeenCalled();
  });
  test("errors reveal only safe codes and do not overwrite a different current login", async () => {
    const h = harness(); const started = await h.handlers.login(h.post({}));
    vi.mocked(h.service.callback).mockRejectedValueOnce(new OidcIdentityError("actor_changed"));
    const response = await h.handlers.callback(new Request(`${origin}/callback?state=${state}&error_description=secret`, {
      headers: { cookie: started.headers.get("set-cookie")!.split(";")[0]! },
    }));
    expect(response.headers.get("location")).toBe(`${origin}/sign-in?notice=actor_changed`);
    expect(response.headers.get("set-cookie")).not.toContain("__Host-pawket.session=");
  });
  test("backchannel accepts bounded form bodies and relies on signed token verification", async () => {
    const h = harness();
    const request = (body: string) => new Request(`${origin}/logout`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    expect((await h.handlers.backchannelLogout(request("logout_token=synthetic.jwt"))).status).toBe(200);
    expect(h.service.backchannelLogout).toHaveBeenCalledWith("synthetic.jwt");
    expect((await h.handlers.backchannelLogout(request("logout_token=a&logout_token=b"))).status).toBe(400);
    expect((await h.handlers.backchannelLogout(request(`logout_token=${"x".repeat(25_000)}`))).status).toBe(400);
    vi.mocked(h.service.backchannelLogout).mockRejectedValueOnce(new OidcIdentityError("invalid_response"));
    expect((await h.handlers.backchannelLogout(request("logout_token=forged.jwt"))).status).toBe(400);
  });
  test("rate limit failures prevent authorization and old credential endpoints are retired", async () => {
    const h = harness(); h.throttle.mockResolvedValueOnce(false);
    expect((await h.handlers.login(h.post({}))).status).toBe(429);
    expect(h.service.begin).not.toHaveBeenCalled();
    const response = h.handlers.retired(); expect(response.status).toBe(410); expect(await response.json()).toEqual({ code: "AUTH_MOVED" });
  });
  test("opaque cookie parser rejects duplicates and quoted/signed legacy formats", () => {
    expect(readOpaqueCookie(new Headers({ cookie: `name=${session}` }), "name")).toBe(session);
    for (const cookie of [`name=${session}; name=${session}`, `name="${session}"`, `name=${session}.signature`, "name=short"])
      expect(readOpaqueCookie(new Headers({ cookie }), "name")).toBeUndefined();
  });
});
