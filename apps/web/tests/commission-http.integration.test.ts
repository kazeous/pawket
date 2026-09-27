import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createCommissionOrderService, type CommissionRoute } from "@pawket/orders";
import { createCreatorCommissionPaymentService, TipPaymentError } from "@pawket/payments";
import { createCommissionHttpHandlers } from "../src/platform/commission-http.js";
import { createCommissionOrderTestFixture } from "./commission-order-test-support.js";

const f = createCommissionOrderTestFixture("commission_http");
beforeAll(f.initialize, 30_000); afterAll(f.dispose, 30_000);
const origin = "https://pawket.example.invalid";
async function setup(route: CommissionRoute = "fixed_immediate") {
  const s = await f.setup(route); const throttle = vi.fn(async () => true);
  const manual = createCreatorCommissionPaymentService({ ...s.creator.common, applicationRevision: "synthetic-i6", paymentsMode: "manual_only", recentAuthMs: 900_000,
    totpAuthMs: 300_000, assurance: s.creator.assurance, commissions: s.service.paymentsLifecycle });
  const input = { appBaseUrl: origin, lookupHmacKey: s.creator.common.lookupHmacKey, intakeMode: "enabled" as const, paymentsMode: "manual_only" as const,
    authenticate: async (headers: Headers) => {
      const userId = headers.get("x-synthetic-user"); const sessionId = headers.get("x-synthetic-session");
      return userId && sessionId && s.users.get(userId) === sessionId ? { userId, sessionId } : null;
    }, throttle, orders: s.service, catalog: s.catalog, manual };
  const handlers = createCommissionHttpHandlers(input);
  const req = (method = "GET", payload?: unknown, actor = s.buyerActor, query = "") => new Request(`${origin}/api/v1/commissions${query}`, { method,
    headers: { origin, "x-real-ip": "192.0.2.60", "x-synthetic-user": actor.userId, "x-synthetic-session": actor.sessionId,
      "content-type": "application/json", "idempotency-key": randomUUID() }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  const requestBody = () => { const command = s.request(); return { packageId: command.packageId, revisionId: command.revisionId, policyRevisionId: command.policyRevisionId,
    acceptTerms: command.acceptTerms, brief: command.brief }; };
  return { ...s, orderInput: s.input, input, handlers, req, requestBody, throttle };
}
async function json(response: Response, status = 200) {
  expect(response.status).toBe(status); expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer"); return response.json();
}
describe("commission HTTP boundary", () => {
  test.each(["fixed_immediate", "fixed_approval", "custom_quote"] as const)("%s exposes the complete authenticated request-to-payment journey", async (route) => {
    const s = await setup(route); const request = s.req("POST", s.requestBody());
    const { orderId } = await json(await s.handlers.request(request.clone()));
    expect(await json(await s.handlers.request(request.clone()))).toEqual({ orderId });
    if (route === "fixed_approval") await json(await s.handlers.mutate(s.req("POST", { expectedVersion: 1, quoteRevisionId: null, policyRevisionId: s.policyId, acceptTerms: true }, s.creator.actor), orderId, "creator", "accept"));
    if (route === "custom_quote") {
      await json(await s.handlers.mutate(s.req("POST", { expectedVersion: 1, terms: s.terms, ttlMs: 86_400_000 }, s.creator.actor), orderId, "creator", "quote"));
      const { order } = await json(await s.handlers.detail(s.req(), orderId, "buyer"));
      await json(await s.handlers.mutate(s.req("POST", { expectedVersion: 2, quoteRevisionId: order.quote.id, policyRevisionId: s.policyId, acceptTerms: true }), orderId, "buyer", "accept"));
    }
    const { order } = await json(await s.handlers.detail(s.req(), orderId, "buyer")); expect(order.payment.instruction.qrPayload).toBeTruthy();
    await json(await s.handlers.mutate(s.req("POST", { expectedVersion: order.version }), orderId, "buyer", "claim"));
    const command = s.req("POST", { observedAmountVnd: order.payment.amountVnd, observedTransferReference: order.payment.reference,
      observedBankTransactionId: randomUUID(), attestedReceived: true }, s.creator.actor);
    await json(await s.handlers.confirm(command.clone(), orderId)); await json(await s.handlers.confirm(command.clone(), orderId));
    expect((await json(await s.handlers.detail(s.req(), orderId, "buyer"))).order).toMatchObject({ state: "in_progress", payment: { instruction: null, confirmationSource: "creator_manual" } });
    expect((await json(await s.handlers.list(s.req(), "buyer"))).orders.items).toHaveLength(1);
    await json(await s.handlers.history(s.req(), orderId, "buyer", "quotes")); await json(await s.handlers.history(s.req(), orderId, "buyer", "timeline"));
  });
  test("guests, unrelated accounts and wrong route roles cannot read or confirm private orders", async () => {
    const s = await setup(); const { orderId } = await json(await s.handlers.request(s.req("POST", s.requestBody())));
    const guest = s.req(); guest.headers.delete("x-synthetic-user");
    await json(await s.handlers.detail(guest, orderId, "buyer"), 401);
    const stranger = await s.buyer();
    for (const id of [orderId, randomUUID()]) expect(await json(await s.handlers.detail(s.req("GET", undefined, stranger), id, "buyer"), 404)).toEqual({ code: "not_available" });
    await json(await s.handlers.detail(s.req(), orderId, "creator"), 404);
    await json(await s.handlers.confirm(s.req("POST", {}), orderId), 404);
    await json(await s.handlers.workspace(s.req()), 404);
    const spoofed = { ...s.requestBody(), actor: s.creator.actor }; await json(await s.handlers.request(s.req("POST", spoofed)), 400);
  });
  test("same-origin, network attribution, schema, media type and streaming size are enforced", async () => {
    const s = await setup();
    for (const [header, value, status] of [["origin", "https://untrusted.example.invalid", 403], ["sec-fetch-site", "cross-site", 403],
      ["x-real-ip", "garbage", 503], ["content-type", "text/plain", 415], ["content-encoding", "gzip", 400], ["idempotency-key", "", 400]] as const) {
      const request = s.req("POST", s.requestBody()); request.headers.set(header, value); await json(await s.handlers.request(request), status);
    }
    await json(await s.handlers.request(s.req("GET")), 405);
    await json(await s.handlers.request(s.req("POST", { ...s.requestBody(), brief: { text: "x".repeat(65_537), referenceLinks: [] } })), 413);
    // A valid Unicode brief is larger than the legacy tip body's 4 KiB limit.
    await json(await s.handlers.request(s.req("POST", { ...s.requestBody(), brief: { text: "🎨".repeat(3_000), referenceLinks: [] } })));
    for (const query of ["?role=creator", "?limit=1&limit=2", "?limit=0", "?beforeId=" + randomUUID(), "?limit=1e2"])
      await json(await s.handlers.list(s.req("GET", undefined, s.buyerActor, query), "buyer"), 400);
    expect(JSON.stringify(s.throttle.mock.calls)).not.toContain("192.0.2.60");
    s.throttle.mockResolvedValue(false); await json(await s.handlers.list(s.req(), "buyer"), 429);
  });
  test("pause preserves private history and closing, while disabling new intake and confirmation", async () => {
    const s = await setup(); const { orderId } = await json(await s.handlers.request(s.req("POST", s.requestBody())));
    const orders = createCommissionOrderService({ ...s.orderInput, intakeMode: "disabled", paymentsMode: "disabled" });
    const manual = createCreatorCommissionPaymentService({ ...s.creator.common, applicationRevision: "synthetic-i6", paymentsMode: "disabled", recentAuthMs: 900_000,
      totpAuthMs: 300_000, assurance: s.creator.assurance, commissions: orders.paymentsLifecycle });
    const paused = createCommissionHttpHandlers({ ...s.input, intakeMode: "disabled", paymentsMode: "disabled", orders, manual });
    const { order } = await json(await paused.detail(s.req(), orderId, "buyer")); expect(order.payment.instruction).toBeNull();
    expect(await json(await paused.request(s.req("POST", s.requestBody())), 503)).toEqual({ code: "intake_disabled" });
    expect(await json(await paused.confirm(s.req("POST", { observedAmountVnd: order.payment.amountVnd, observedTransferReference: order.payment.reference,
      observedBankTransactionId: randomUUID(), attestedReceived: true }, s.creator.actor), orderId), 503)).toEqual({ code: "payments_disabled" });
    await json(await paused.mutate(s.req("POST", { expectedVersion: order.version }), orderId, "buyer", "close"));
    expect((await json(await paused.detail(s.req(), orderId, "buyer"))).order.state).toBe("closed");
    await json(await paused.workspace(s.req("GET", undefined, s.creator.actor)));
  });
  test("recent authentication failures are bounded responses, without leaking internal error details", async () => {
    const s = await setup(); const { orderId } = await json(await s.handlers.request(s.req("POST", s.requestBody())));
    const handlers = createCommissionHttpHandlers({ ...s.input, manual: { confirm: async () => { throw new TipPaymentError("recent_auth_required"); } } });
    expect(await json(await handlers.confirm(s.req("POST", { observedAmountVnd: 500_000, observedTransferReference: "PW" + "A".repeat(20), observedBankTransactionId: "synthetic", attestedReceived: true }, s.creator.actor), orderId), 403)).toEqual({ code: "recent_auth_required" });
  });
});
