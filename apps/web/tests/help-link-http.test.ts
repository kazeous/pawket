import { expect, test, vi } from "vitest";
import { TrustEnforcementError, deriveTrustedNetworkKey } from "@pawket/trust";
import { createHelpLinkHttpHandlers } from "../src/platform/help-link-http.js";
const origin = "https://pawket.example.invalid"; const key = new Uint8Array(32).fill(5);
const token = Buffer.alloc(32, 7).toString("base64url");
let routeHandlers: ReturnType<typeof createHelpLinkHttpHandlers>;
vi.mock("../src/platform/runtime", () => ({ getPlatformRuntime: () => ({ helpLinkHandlers: routeHandlers }) }));
function fixture() {
  const helpLinks = { openSession: vi.fn().mockResolvedValue({ sessionToken: token, penaltyId: "private-penalty", expiresAt: new Date("2026-10-12T03:30:00Z") }), requestLink: vi.fn().mockResolvedValue(undefined), revokeSession: vi.fn().mockResolvedValue(undefined) };
  const logger = { error: vi.fn() };
  return { helpLinks, logger, http: createHelpLinkHttpHandlers({ appBaseUrl: origin, mode: "enabled", lookupHmacKey: key, helpLinks, logger }) };
}
function request(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${origin}/help/locked/${path}`, { method: "POST", headers: { origin, "content-type": "application/json", "x-real-ip": "192.0.2.1", ...headers }, body: JSON.stringify(body) });
}
test("session route sets the cookie with Path=/help/locked, HttpOnly, Secure, SameSite=Strict", async () => {
  const f = fixture(); const req = request("session", { token });
  const response = await f.http.session(req);
  expect(response.status).toBe(204); expect(await response.text()).toBe("");
  expect(response.headers.get("set-cookie")).toBe(`pawket_help=${token}; Path=/help/locked; HttpOnly; Secure; SameSite=Strict; Max-Age=1800`);
  expect(f.helpLinks.openSession).toHaveBeenCalledWith({ token, networkKeyHmac: deriveTrustedNetworkKey(req.headers, key) });
  expect(response.headers.get("cache-control")).toContain("no-store");
});

test("disabled session exchange returns the expired-link response before opening a session", async () => {
  const f = fixture(); const http = createHelpLinkHttpHandlers({ appBaseUrl: origin, mode: "disabled", lookupHmacKey: key, helpLinks: f.helpLinks, logger: f.logger });
  const response = await http.session(request("session", { token }));
  expect(response.status).toBe(400); expect(response.headers.has("set-cookie")).toBe(false); expect(f.helpLinks.openSession).not.toHaveBeenCalled();
});
test("disabled link request returns 204 without calling the service", async () => {
  const f = fixture(); const http = createHelpLinkHttpHandlers({ appBaseUrl: origin, mode: "disabled", lookupHmacKey: key, helpLinks: f.helpLinks, logger: f.logger });
  const response = await http.linkRequest(request("link-request", { email: "locked@example.invalid" }));
  expect(response.status).toBe(204); expect(await response.text()).toBe(""); expect(f.helpLinks.requestLink).not.toHaveBeenCalled();
});
test("end route revokes the cookie session, expires the scoped cookie and returns an empty success for fetch", async () => {
  const f = fixture(); routeHandlers = f.http; const route = await import("../src/app/help/locked/end/route.js");
  const response = await route.POST(request("end", {}, { cookie: `pawket_help=${token}; pawket_identity=unrelated` }));
  expect(f.helpLinks.revokeSession).toHaveBeenCalledWith(token); expect(response.status).toBe(204); expect(response.headers.has("location")).toBe(false); expect(await response.text()).toBe("");
  expect(response.headers.get("set-cookie")).toBe("pawket_help=; Path=/help/locked; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  expect(response.headers.get("cache-control")).toContain("no-store");
});
test("end session is idempotent without a cookie and refuses cross-site requests", async () => {
  const f = fixture(); expect((await f.http.endSession(request("end", {}))).status).toBe(204); expect(f.helpLinks.revokeSession).not.toHaveBeenCalled();
  const rejected = await f.http.endSession(request("end", {}, { cookie: `pawket_help=${token}`, origin: "https://foreign.invalid" }));
  expect(rejected.status).toBe(403); expect(rejected.headers.has("set-cookie")).toBe(false); expect(f.helpLinks.revokeSession).not.toHaveBeenCalled();
});
test.each(["null", "missing"])("end route refuses %s Origin without revoking or clearing the session", async (originValue) => {
  const f = fixture(); routeHandlers = f.http; const route = await import("../src/app/help/locked/end/route.js");
  const req = request("end", {}, { cookie: `pawket_help=${token}`, origin: originValue });
  if (originValue === "missing") req.headers.delete("origin");
  const response = await route.POST(req);
  expect(response.status).toBe(403); expect(response.headers.has("set-cookie")).toBe(false); expect(f.helpLinks.revokeSession).not.toHaveBeenCalled();
});
test("failed revocation keeps the cookie available for retry and masks private errors", async () => {
  const f = fixture(); f.helpLinks.revokeSession.mockRejectedValue(new Error(token));
  const response = await f.http.endSession(request("end", {}, { cookie: `pawket_help=${token}` }));
  expect(response.status).toBe(503); expect(response.headers.has("set-cookie")).toBe(false); expect(await response.text()).not.toContain(token);
});
test("both POST route modules delegate under the help cookie path", async () => {
  const f = fixture(); routeHandlers = f.http;
  const session = await import("../src/app/help/locked/session/route.js");
  const resend = await import("../src/app/help/locked/link-request/route.js");
  const opened = await session.POST(request("session", { token }));
  expect(opened.headers.get("set-cookie")).toContain("Path=/help/locked");
  expect((await resend.POST(request("link-request", { email: "locked@example.invalid" }))).status).toBe(204);
});
test.each(["unknown", "active", "locked"])("link-request always returns 204 for %s email", async (email) => {
  const f = fixture(); const response = await f.http.linkRequest(request("link-request", { email: `${email}@example.invalid` }));
  expect(response.status).toBe(204); expect(await response.text()).toBe(""); expect(response.headers.has("set-cookie")).toBe(false);
  expect(f.helpLinks.requestLink).toHaveBeenCalledOnce();
});
test.each(["not_available", "invalid_request"] as const)("session failure %s has the same public response and no cookie", async (code) => {
  const f = fixture(); f.helpLinks.openSession.mockRejectedValue(new TrustEnforcementError(code));
  const response = await f.http.session(request("session", { token }));
  expect(response.status).toBe(400); expect(await response.json()).toEqual({ code: "not_available" }); expect(response.headers.has("set-cookie")).toBe(false);
});
test("cross-site, unknown fields, query tokens, and untrusted networks are refused before the service", async () => {
  const f = fixture();
  for (const req of [request("session", { token }, { origin: "https://foreign.invalid" }), request("session", { token }, { "sec-fetch-site": "cross-site" }),
    request("session?t=secret", { token }), request("session", { token, userId: "foreign" }), request("session", { token }, { "x-real-ip": "bad" })]) {
    expect((await f.http.session(req)).status).toBeGreaterThanOrEqual(400);
  }
  expect(f.helpLinks.openSession).not.toHaveBeenCalled();
});
test("invalid email requests and unavailable dependencies disclose no address outcome", async () => {
  const f = fixture(); f.helpLinks.requestLink.mockRejectedValue(new Error(`unknown@example.invalid ${token} private-user`));
  const response = await f.http.linkRequest(request("link-request", { email: "unknown@example.invalid" }));
  expect(response.status).toBe(204); expect(await response.text()).toBe("");
  expect(f.logger.error.mock.calls).toEqual([["Help-link resend handler failed"]]);
  expect((await f.http.linkRequest(request("link-request", { email: "" }))).status).toBe(204);
});
