import { describe, expect, test, vi } from "vitest";
import { createOidcAccountHttpHandlers } from "../src/oidc-account-http.js";
import type { OidcSessionContext } from "../src/oidc-session.js";

const actor: OidcSessionContext = { userId: "user", sessionId: "session", authorizationVersion: 1, subject: "subject",
  primaryAuthenticatedAt: new Date(), mfaVerifiedAt: null, totpStatus: "not_enrolled", sessionExpiresAt: new Date(),
  idpValidUntil: new Date(), leaseRequired: false, owner: false };
function fixture(leaseRequired = false) {
  const revoke = vi.fn(async () => true); const revokeAll = vi.fn(async () => 2);
  const authenticate = vi.fn(async () => ({ ...actor, leaseRequired }));
  return { revoke, revokeAll, authenticate, handlers: createOidcAccountHttpHandlers({ baseURL: "https://pawket.example",
    accountPortalUrl: "https://idp.example/if/user/", authenticate, getMe: async () => ({ id: "user", twoFactorEnabled: true }),
    listSessions: async () => [{ id: "session", deviceLabel: "Browser", createdAt: new Date(), lastUsedAt: new Date() }],
    revokeSession: revoke, revokeAllSessions: revokeAll }) };
}
function request(method: string, origin = "https://pawket.example") {
  return new Request("https://pawket.example/api/v1/me/sessions", { method, headers: { origin } });
}
describe("OIDC local account endpoints", () => {
  test("retired credential operations never use local identity services", async () => {
    const { handlers, authenticate } = fixture();
    for (const handler of [handlers.register, handlers.verifyEmail, handlers.resetPassword, handlers.changePassword, handlers.completeEmailChange]) {
      const response = handler(request("POST")); expect(response.status).toBe(410); expect(await response.json()).toEqual({ code: "AUTH_MOVED" });
    }
    expect(authenticate).not.toHaveBeenCalled();
  });
  test("me uses current OIDC enrollment instead of the legacy factor flag", async () => {
    expect(await (await fixture().handlers.me(request("GET"))).json()).toMatchObject({ user: { twoFactorEnabled: false }, identityProvider: "authentik" });
  });
  test("expired lease cannot read account or sessions", async () => {
    const { handlers } = fixture(true);
    for (const handler of [handlers.me, handlers.sessions]) expect(await (await handler(request("GET"))).json()).toEqual({ code: "OIDC_LEASE_REQUIRED" });
  });
  test("logout and revoke-all work after the lease expires and clear the host cookie", async () => {
    const { handlers, revoke, revokeAll } = fixture(true);
    const single = await handlers.logout(request("POST")); expect(single.status).toBe(204);
    expect(single.headers.get("set-cookie")).toContain("__Host-pawket.session=; Max-Age=0");
    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ userId: "user", sessionId: "session" }));
    expect((await handlers.sessions(request("DELETE"))).status).toBe(204); expect(revokeAll).toHaveBeenCalledOnce();
  });
  test("cross-origin session revocation is rejected before authentication", async () => {
    const { handlers, authenticate, revokeAll } = fixture();
    expect((await handlers.logout(request("POST", "https://attacker.example"))).status).toBe(403);
    expect((await handlers.sessions(request("DELETE", "https://attacker.example"))).status).toBe(403);
    expect(authenticate).not.toHaveBeenCalled(); expect(revokeAll).not.toHaveBeenCalled();
  });
});
