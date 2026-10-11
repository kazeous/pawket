import { expect, test, vi } from "vitest";
import { TrustEnforcementError, deriveTrustedNetworkKey } from "@pawket/trust";
import { createHelpLinkHttpHandlers } from "../src/platform/help-link-http.js";
const origin = "https://pawket.example.invalid"; const key = new Uint8Array(32).fill(5);
const token = Buffer.alloc(32, 7).toString("base64url");
let routeHandlers: ReturnType<typeof createHelpLinkHttpHandlers>;
vi.mock("../src/platform/runtime", () => ({ getPlatformRuntime: () => ({ helpLinkHandlers: routeHandlers }) }));
function fixture() {
  const helpLinks = { openSession: vi.fn().mockResolvedValue({ sessionToken: token, penaltyId: "private-penalty", expiresAt: new Date("2026-10-12T03:30:00Z") }), requestLink: vi.fn().mockResolvedValue(undefined) };
  const logger = { error: vi.fn() };
  return { helpLinks, logger, http: createHelpLinkHttpHandlers({ appBaseUrl: origin, lookupHmacKey: key, helpLinks, logger }) };
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
