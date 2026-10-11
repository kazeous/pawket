import { describe, expect, test, vi } from "vitest";
import { TrustEnforcementError } from "@pawket/trust";
import { createTrustEnforcementHttpHandlers } from "../src/platform/trust-enforcement-http.js";
import { oidcCommand } from "../src/platform/oidc-command-registry.js";
import { createAppealHttpHandlers } from "../src/platform/appeal-http.js";

const origin = "https://pawket.example.invalid";
const actor = { userId: "synthetic-user", sessionId: "synthetic-session" };
const target = { kind: "commission_package", packageId: "11111111-1111-4111-8111-111111111111", revisionId: "22222222-2222-4222-8222-222222222222" };
function fixture(guest = false) {
  const reports = { submit: vi.fn().mockResolvedValue({ accepted: true, reportReference: `report:v2:${"a".repeat(32)}`, caseId: target.packageId }),
    issueChallenge: vi.fn().mockResolvedValue({ token: "synthetic-token", difficulty: 18, expiresAt: "2026-10-11T04:00:00Z" }) };
  const authenticate = vi.fn().mockResolvedValue(guest ? null : actor);
  return { reports, authenticate, http: createTrustEnforcementHttpHandlers({ appBaseUrl: origin, lookupHmacKey: new Uint8Array(32).fill(9), authenticate, reports }) };
}
function request(body: unknown = { target, reason: "other", detail: null }, headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/v1/reports`, { method: "POST", headers: { origin, "content-type": "application/json", "x-real-ip": "192.0.2.1", "idempotency-key": "synthetic-key", ...headers }, body: JSON.stringify(body) });
}
describe("trust reports HTTP", () => {
  test.each(["duplicate", "not_available", "restricted", "invalid_request", "idempotency_conflict"] as const)("%s is a generic 400 rejection", async (code) => {
    const f = fixture(); f.reports.submit.mockRejectedValue(new TrustEnforcementError(code));
    const response = await f.http.submit(request()); expect(response.status).toBe(400); expect(await response.json()).toEqual({ code: "REPORT_NOT_ACCEPTED" });
  });
  test("rate limit is 429 and disabled is 404 with generic bodies", async () => {
    for (const [code, status] of [["rate_limited", 429], ["enforcement_disabled", 404]] as const) {
      const f = fixture(); f.reports.submit.mockRejectedValue(new TrustEnforcementError(code));
      const response = await f.http.submit(request()); expect(response.status).toBe(status); expect(await response.json()).toEqual({ code: "REPORT_NOT_ACCEPTED" });
    }
  });
  test("authenticated submit uses only session identity and requires idempotency", async () => {
    const f = fixture(); const response = await f.http.submit(request()); expect(response.status).toBe(202);
    expect(f.reports.submit).toHaveBeenCalledWith(expect.objectContaining({ requester: { kind: "authenticated", actor }, idempotencyKey: "synthetic-key" }));
    const missing = request(); missing.headers.delete("idempotency-key"); expect((await f.http.submit(missing)).status).toBe(400);
    for (const header of ["cache-control", "referrer-policy", "x-content-type-options"]) expect(response.headers.has(header)).toBe(true);
  });
  test("guest package requires challenge; private guest target is refused before service", async () => {
    const f = fixture(true); expect((await f.http.submit(request())).status).toBe(400);
    expect((await f.http.submit(request({ target: { kind: "commission_brief", orderId: target.packageId }, reason: "other", challenge: { token: "x", solution: 0 } }))).status).toBe(400);
    expect(f.reports.submit).not.toHaveBeenCalled();
    expect((await f.http.submit(request({ target, reason: "other", challenge: { token: "x", solution: 0 } }))).status).toBe(202);
    expect(f.reports.submit.mock.calls[0]![0].requester.networkKeyHmac).toMatch(/^hmac-sha256:v1:/u);
  });
  test("challenge POST uses trusted network and same origin", async () => {
    const f = fixture(true); expect((await f.http.challenge(request({}))).status).toBe(200);
    expect(f.reports.issueChallenge).toHaveBeenCalledWith({ networkKeyHmac: expect.stringMatching(/^hmac-sha256:v1:/u) });
    expect((await f.http.challenge(request({}, { origin: "https://foreign.invalid" }))).status).toBe(403);
  });
  test("unknown fields, cross-site, invalid JSON and excessive body are rejected", async () => {
    const f = fixture();
    expect((await f.http.submit(request({ target, reason: "other", reporterUserId: "other-user" }))).status).toBe(400);
    expect((await f.http.submit(request(undefined, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect((await f.http.submit(request({ target, reason: "other", detail: "x".repeat(65_537) }))).status).toBe(413);
    expect(f.reports.submit).not.toHaveBeenCalled();
  });
  test("OIDC registry assigns a non-fresh party action", () => {
    const command = oidcCommand({ method: "POST", path: "/api/v1/reports", body: "{}", idempotencyKey: "key", ifMatch: null, returnPath: "/" });
    expect(command?.policy).toEqual({ actionClass: "trust.report_submit", fresh: false });
  });
});

describe("appeals HTTP", () => {
  function appealFixture() {
    const appeals = { submit: vi.fn().mockResolvedValue({ appealId: target.packageId, caseId: target.revisionId }) };
    const authenticate = vi.fn().mockResolvedValue(actor);
    return { appeals, authenticate, http: createAppealHttpHandlers({ appBaseUrl: origin, appeals, authenticate }) };
  }
  const body = { target: { penaltyId: target.packageId }, statement: "Xin xem lại" };
  test("session identity is authoritative, non-fresh OIDC registered, private response", async () => {
    const f = appealFixture(); const response = await f.http.submit(request(body));
    expect(response.status).toBe(202);
    expect(f.appeals.submit).toHaveBeenCalledWith(expect.objectContaining({ appellant: { kind: "session", actor }, ...body, idempotencyKey: "synthetic-key" }));
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(oidcCommand({ method: "POST", path: "/api/v1/help/appeals", body: "{}", idempotencyKey: "key", ifMatch: null, returnPath: "/" })?.policy).toEqual({ actionClass: "trust.appeal_submit", fresh: false });
    expect(oidcCommand({ method: "POST", path: `/api/v1/admin/cases/${target.packageId}/actions`, body: JSON.stringify({ action: "decide_appeal" }), idempotencyKey: "key", ifMatch: null, returnPath: "/" })?.policy).toEqual({ actionClass: "owner.trust_appeal_decide", fresh: true });
  });
  test("help appeal reads only one pawket_help cookie and needs no signed-in session", async () => {
    const f = appealFixture(); const sessionToken = "a".repeat(43);
    expect((await f.http.lockedSubmit(request(body, { cookie: `unrelated=x; pawket_help=${sessionToken}` }))).status).toBe(202);
    expect(f.authenticate).not.toHaveBeenCalled();
    expect(f.appeals.submit).toHaveBeenCalledWith(expect.objectContaining({ appellant: { kind: "help_session", sessionToken } }));
    for (const cookie of ["", "pawket_help=invalid", `pawket_help=${sessionToken}; pawket_help=${sessionToken}`]) expect((await f.http.lockedSubmit(request(body, { cookie }))).status).toBe(401);
  });
  test("authentication, origin, query, idempotency and exact shapes are checked before submit", async () => {
    const f = appealFixture(); f.authenticate.mockResolvedValueOnce(null);
    expect((await f.http.submit(request(body))).status).toBe(401);
    expect((await f.http.submit(request(body, { origin: "https://foreign.invalid" }))).status).toBe(403);
    const missing = request(body); missing.headers.delete("idempotency-key"); expect((await f.http.submit(missing)).status).toBe(400);
    for (const value of [{ ...body, userId: "someone" }, { ...body, target: { penaltyId: target.packageId, hideId: target.revisionId } }, { ...body, sessionToken: "secret" }]) expect((await f.http.submit(request(value))).status).toBe(400);
    expect(f.appeals.submit).not.toHaveBeenCalled();
  });
  test.each([["duplicate", 409], ["window_closed", 409], ["not_available", 404], ["enforcement_disabled", 503], ["invalid_request", 400]] as const)("%s returns %s without sensitive details", async (code, status) => {
    const f = appealFixture(); f.appeals.submit.mockRejectedValue(new TrustEnforcementError(code));
    const response = await f.http.submit(request(body)); expect(response.status).toBe(status); expect(await response.json()).toEqual({ code });
  });
});
