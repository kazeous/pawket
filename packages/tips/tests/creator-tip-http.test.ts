import { describe, expect, test, vi } from "vitest";
import { requireIntegerVnd, TipPaymentError, type CreatorTipProjection, type CreatorTipQueue } from "@pawket/payments";
import { createCreatorTipHttpHandlers } from "../src/creator-tip-http.js";

const intentId = "73bcae8b-2eb4-4dc3-ab33-e92306a9c28d";
const actor = { userId: "authenticated-creator", sessionId: "authoritative-session" };
const reference = `PW${"0".repeat(20)}`;
const body = { observedAmountVnd: 50_000, observedTransferReference: reference, observedBankTransactionId: "bank-private-transaction", attestedReceived: true };
const completed: CreatorTipProjection = { id: intentId, reference, amountVnd: requireIntegerVnd(50_000), state: "confirmed", expiresAt: "2026-09-13T00:00:00.000Z",
  confirmedAt: "2026-09-12T00:00:00.000Z", transferClaimedAt: null, guestContent: { name: "Guest", message: "Thank you" } };
function setup(overrides: Partial<Parameters<typeof createCreatorTipHttpHandlers>[0]> = {}) {
  const service = { listQueue: vi.fn(async (): Promise<CreatorTipQueue> => ({ items: [], nextCursor: null })), confirm: vi.fn(async (): Promise<CreatorTipProjection> => completed) };
  const authenticate = vi.fn(async (): Promise<typeof actor | null> => actor); const throttle = vi.fn(async () => true);
  const handlers = createCreatorTipHttpHandlers({ appBaseUrl: "https://pawket.test", paymentsMode: "manual_only", lookupHmacKey: new Uint8Array(32).fill(29), service, authenticate, throttle, ...overrides });
  return { service, authenticate, throttle, handlers };
}
function request(init: RequestInit = {}, query = "") {
  const method = init.method ?? "POST";
  return new Request(`https://pawket.test/api/v1/creator/tips/${intentId}/confirm${query}`, { method, ...(method === "POST" ? { body: JSON.stringify(body) } : {}), ...init,
    headers: { origin: "https://pawket.test", "content-type": "application/json", "x-real-ip": "192.0.2.9", "idempotency-key": "safe-test-command", ...Object.fromEntries(new Headers(init.headers).entries()) } });
}
function privateResponse(response: Response) {
  expect(response.headers.get("cache-control")).toContain("no-store"); expect(response.headers.get("referrer-policy")).toBe("no-referrer");
}
describe("creator confirmation HTTP boundary", () => {
  test("binds commands only to the authenticated session and returns the committed creator projection", async () => {
    const s = setup(); const response = await s.handlers.confirm(request(), intentId);
    expect(response.status).toBe(200); privateResponse(response); expect(await response.json()).toEqual({ tip: completed });
    expect(s.service.confirm).toHaveBeenCalledWith({ actor, paymentIntentId: intentId, ...body, idempotencyKey: "safe-test-command", requestId: expect.any(String) });
    expect(s.throttle).toHaveBeenCalledWith({ actorUserId: actor.userId, operation: "confirm", networkKeyHash: expect.stringMatching(/^hmac-sha256:v1:/u) });
  });
  test("blocks missing sessions, disabled mode, cross-origin POST and cross-site GET", async () => {
    const s = setup(); s.authenticate.mockResolvedValueOnce(null);
    expect((await s.handlers.confirm(request(), intentId)).status).toBe(401); expect(s.service.confirm).not.toHaveBeenCalled();
    expect((await setup({ paymentsMode: "disabled" }).handlers.confirm(request(), intentId)).status).toBe(503);
    const untrusted = await s.handlers.confirm(request({ headers: { origin: "https://elsewhere.test" } }), intentId);
    expect(untrusted.status).toBe(403); privateResponse(untrusted);
    expect((await s.handlers.queue(request({ method: "GET", headers: { "sec-fetch-site": "cross-site" } }))).status).toBe(403);
  });
  test.each(["actor", "creatorUserId", "primaryAuthenticatedAt", "totpVerifiedAt", "totpEnrolled", "paymentIntentId"]) ("rejects client-supplied authority or identity fields (%s)", async (field) => {
    const s = setup(); const response = await s.handlers.confirm(request({ body: JSON.stringify({ ...body, [field]: "forged" }) }), intentId);
    expect(response.status).toBe(400); expect(s.service.confirm).not.toHaveBeenCalled();
  });
  test.each([false, "true", null])("requires literal attestation and cannot infer it (%s)", async (attestedReceived) => {
    const s = setup(); expect((await s.handlers.confirm(request({ body: JSON.stringify({ ...body, attestedReceived }) }), intentId)).status).toBe(400);
    expect(s.service.confirm).not.toHaveBeenCalled();
  });
  test("bounds body, path, query and command key before calling confirmation", async () => {
    const s = setup();
    expect((await s.handlers.confirm(request({ body: " ".repeat(4097) }), intentId)).status).toBe(413);
    expect((await s.handlers.confirm(request(), "not-an-id")).status).toBe(400);
    expect((await s.handlers.confirm(request({}, "?actor=victim"), intentId)).status).toBe(400);
    expect((await s.handlers.confirm(request({ headers: { "idempotency-key": "short" } }), intentId)).status).toBe(400);
    expect(s.service.confirm).not.toHaveBeenCalled();
  });
  test("queue accepts only bounded filters/cursor and cannot take a target creator from the client", async () => {
    const s = setup();
    const response = await s.handlers.queue(request({ method: "GET" }, "?state=confirmed&cursor=opaque"));
    expect(response.status).toBe(200); privateResponse(response);
    expect(s.service.listQueue).toHaveBeenCalledWith({ actor, state: "confirmed", cursor: "opaque" });
    for (const query of ["?creatorUserId=victim", "?state=confirmed&state=expired", "?cursor=", `?cursor=${"a".repeat(401)}`, "?state=unknown"]) expect((await s.handlers.queue(request({ method: "GET" }, query))).status).toBe(400);
    expect(s.service.listQueue).toHaveBeenCalledTimes(1);
  });
  test.each([
    ["not_authorized", 404], ["recent_auth_required", 403], ["totp_required", 403], ["evidence_mismatch", 422],
    ["bank_transaction_conflict", 409], ["intent_not_pending", 409], ["idempotency_conflict", 409],
  ] as const)("returns stable safe failure for %s", async (code, status) => {
    const s = setup(); s.service.confirm.mockRejectedValueOnce(new TipPaymentError(code));
    const response = await s.handlers.confirm(request(), intentId);
    expect(response.status).toBe(status); privateResponse(response);
    expect(await response.text()).not.toContain(body.observedBankTransactionId);
  });
  test("rate limits and unavailable dependencies cannot reach the domain command", async () => {
    const s = setup(); s.throttle.mockResolvedValueOnce(false);
    expect((await s.handlers.confirm(request(), intentId)).status).toBe(429);
    s.authenticate.mockRejectedValueOnce(new Error("private session detail"));
    const response = await s.handlers.confirm(request(), intentId);
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ code: "dependency_unavailable" });
    expect(s.service.confirm).not.toHaveBeenCalled();
  });
});
