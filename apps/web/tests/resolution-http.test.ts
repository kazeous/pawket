import { describe, expect, test, vi } from "vitest";
import { CommissionError } from "@pawket/orders";
import { CommissionRefundError } from "@pawket/payments";
import { ResolutionError } from "@pawket/resolutions";
import { COMMISSION_PRIVATE_HEADERS } from "../src/platform/commission-http.js";
import { createResolutionHttpHandlers } from "../src/platform/resolution-http.js";

const orderId = "11111111-1111-4111-8111-111111111111";
const childId = "22222222-2222-4222-8222-222222222222";
const origin = "https://pawket.example.invalid";
const actor = { userId: "synthetic-buyer", sessionId: "synthetic-session" };
type Input = Parameters<typeof createResolutionHttpHandlers>[0];
function fixture(role: "buyer" | "creator" = "buyer", mode: "enabled" | "disabled" = "enabled") {
  const proposals = { propose: vi.fn().mockResolvedValue({ proposalId: childId }), respondToProposal: vi.fn().mockResolvedValue({ proposalId: childId }), withdrawProposal: vi.fn().mockResolvedValue({ proposalId: childId }) };
  const disputes = { openDispute: vi.fn().mockResolvedValue({ disputeId: childId }), addStatement: vi.fn().mockResolvedValue({ statementId: childId }), withdrawDispute: vi.fn().mockResolvedValue({ disputeId: childId }) };
  const refunds = { enterDestination: vi.fn().mockResolvedValue({ version: 2 }), confirmReceipt: vi.fn().mockResolvedValue({ version: 2 }), revealDestination: vi.fn().mockResolvedValue({}), recordSend: vi.fn().mockResolvedValue({ version: 2 }) };
  const lateClaims = { fileLateClaim: vi.fn().mockResolvedValue({ claimId: childId }), answerLateClaim: vi.fn().mockResolvedValue({ claimId: childId }) };
  const suspension = { cancelAfterSuspension: vi.fn().mockResolvedValue({ obligationId: childId }) };
  const view = { getOrderResolution: vi.fn().mockResolvedValue({ role, proposals: { pending: { id: childId }, history: [] }, dispute: { id: childId }, refunds: [{ obligationId: childId }], lateClaim: { id: childId } }), listMyCases: vi.fn().mockResolvedValue({ disputes: [], refunds: [], lateClaims: [] }) };
  const authenticate = vi.fn().mockResolvedValue(actor); const throttle = vi.fn().mockResolvedValue(true);
  const orders = { getOrder: vi.fn().mockResolvedValue({ role }) };
  const http = createResolutionHttpHandlers({ appBaseUrl: origin, lookupHmacKey: new Uint8Array(32).fill(9), mode, authenticate, throttle,
    proposals, disputes, refunds, lateClaims, suspension, view, orders } as unknown as Input);
  return { http, proposals, disputes, refunds, lateClaims, suspension, view, authenticate, throttle, orders };
}
function request(body: unknown = {}, headers: Record<string, string> = {}, method = "POST", query = "") {
  return new Request(`${origin}/api/v1/commissions/${orderId}/proposals${query}`, { method,
    headers: { origin, "x-real-ip": "192.0.2.65", "content-type": "application/json", "idempotency-key": "synthetic-command-key", ...headers },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}) });
}
const proposal = { expectedVersion: 1, kind: "cancel_with_refund", refundAmountVnd: 0, note: "Synthetic note" };
async function code(response: Response, status: number, expected: string) {
  expect(response.status).toBe(status); expect(await response.json()).toEqual({ code: expected });
  for (const [name, value] of Object.entries(COMMISSION_PRIVATE_HEADERS)) expect(response.headers.get(name)).toBe(value);
}
describe("party resolution HTTP boundary", () => {
  test.each<Record<string, string>>([{ origin: "https://foreign.example.invalid" }, { "sec-fetch-site": "cross-site" }])("cross-site POST is refused before authentication", async (headers) => {
    const f = fixture(); await code(await f.http.propose(request(proposal, headers), orderId, "buyer"), 403, "untrusted_origin"); expect(f.authenticate).not.toHaveBeenCalled();
  });
  test("missing idempotency key is refused", async () => {
    const f = fixture(); const req = request(proposal); req.headers.delete("idempotency-key");
    await code(await f.http.propose(req, orderId, "buyer"), 400, "invalid_request"); expect(f.proposals.propose).not.toHaveBeenCalled();
  });
  test("unknown body keys are refused", async () => {
    const f = fixture(); await code(await f.http.propose(request({ ...proposal, extra: true }), orderId, "buyer"), 400, "invalid_request");
  });
  test("a buyer calling creator reveal gets not found", async () => {
    const f = fixture(); await code(await f.http.revealRefund(request(), orderId, childId), 404, "not_available"); expect(f.refunds.revealDestination).not.toHaveBeenCalled();
  });
  test("disabled commands return 503 and reads remain private and available", async () => {
    const f = fixture("buyer", "disabled"); await code(await f.http.propose(request(proposal), orderId, "buyer"), 503, "resolution_disabled");
    expect(f.proposals.propose).not.toHaveBeenCalled();
    const response = await f.http.resolution(request({}, {}, "GET"), orderId, "buyer"); expect(response.status).toBe(200);
    for (const [name, value] of Object.entries(COMMISSION_PRIVATE_HEADERS)) expect(response.headers.get(name)).toBe(value);
  });
  test("refund destination over 64 KiB is refused", async () => {
    const f = fixture(); await code(await f.http.enterRefundDestination(request({ expectedVersion: 1, bankBin: "970415", accountNumber: "0".repeat(65_536), accountHolder: "Synthetic" }), orderId, childId), 413, "invalid_request");
    expect(f.refunds.enterDestination).not.toHaveBeenCalled();
  });
  test.each([
    [new ResolutionError("not_authorized"), 404, "not_available"], [new ResolutionError("proposal_pending"), 409, "proposal_pending"],
    [new ResolutionError("resolution_disabled"), 503, "resolution_disabled"], [new CommissionRefundError("recent_auth_required"), 403, "recent_auth_required"],
    [new CommissionRefundError("totp_required"), 403, "totp_required"], [new CommissionRefundError("invalid_destination"), 400, "invalid_destination"],
    [new CommissionError("invalid_transition"), 400, "invalid_transition"], [new CommissionError("rate_limited"), 429, "rate_limited"],
    [new CommissionError("completion_held"), 409, "completion_held"], [new Error("synthetic dependency failure"), 503, "dependency_unavailable"],
  ] as const)("domain error %s maps to %s", async (error, status, expected) => {
    const f = fixture(); f.proposals.propose.mockRejectedValue(error); await code(await f.http.propose(request(proposal), orderId, "buyer"), status, expected);
  });
  test("throttling uses the commission command bucket and fails closed", async () => {
    const f = fixture(); f.throttle.mockResolvedValue(false); await code(await f.http.propose(request(proposal), orderId, "buyer"), 429, "rate_limited");
    expect(f.throttle.mock.calls[0]?.[0]).toMatchObject({ actorUserId: actor.userId, operation: "command", orderId }); expect(f.proposals.propose).not.toHaveBeenCalled();
  });
  test("unrelated query parameters and wrong methods are refused", async () => {
    const f = fixture(); await code(await f.http.propose(request(proposal, {}, "POST", "?extra=1"), orderId, "buyer"), 400, "invalid_request");
    await code(await f.http.propose(request({}, {}, "GET"), orderId, "buyer"), 405, "method_not_allowed");
  });
  test("every mutation takes its key from the header and forwards only service fields", async () => {
    const f = fixture("creator"); const key = request().headers.get("idempotency-key");
    const calls = [
      () => f.http.propose(request(proposal), orderId, "creator"),
      () => f.http.respondProposal(request({ response: "decline" }), orderId, childId, "creator"),
      () => f.http.withdrawProposal(request(), orderId, childId, "creator"),
      () => f.http.openDispute(request({ expectedVersion: 1, reason: "other", statement: "Synthetic statement", requestedOutcome: { kind: "close", refundAmountVnd: 0 }, acknowledgeStaffReview: true }), orderId, "creator"),
      () => f.http.addStatement(request({ text: "Synthetic statement" }), orderId, childId, "creator"),
      () => f.http.withdrawDispute(request(), orderId, childId, "creator"),
      () => f.http.recordRefundSend(request({ expectedVersion: 1, transferDate: "2026-10-08", bankReference: "synthetic-reference" }), orderId, childId),
      () => f.http.answerLateClaim(request({ received: false }), orderId, childId),
    ];
    for (const call of calls) expect((await call()).status).toBe(200);
    for (const mock of [f.proposals.propose, f.proposals.respondToProposal, f.proposals.withdrawProposal, f.disputes.openDispute, f.disputes.addStatement, f.disputes.withdrawDispute, f.refunds.recordSend, f.lateClaims.answerLateClaim]) {
      expect(mock.mock.calls[0]?.[0].idempotencyKey === key).toBe(true); expect(mock.mock.calls[0]?.[0].actor).toEqual(actor);
    }
    const buyer = fixture();
    for (const call of [() => buyer.http.enterRefundDestination(request({ expectedVersion: 1, bankBin: "970415", accountNumber: "123456789", accountHolder: "Synthetic" }), orderId, childId),
      () => buyer.http.confirmRefundReceipt(request({ expectedVersion: 1, received: true }), orderId, childId),
      () => buyer.http.fileLateClaim(request({ transferAt: "2026-10-08T00:00:00Z", amountVnd: 1, bankReference: "synthetic-reference" }), orderId),
      () => buyer.http.cancelAfterSuspension(request({ expectedVersion: 1 }), orderId)]) expect((await call()).status).toBe(200);
    for (const mock of [buyer.refunds.enterDestination, buyer.refunds.confirmReceipt, buyer.lateClaims.fileLateClaim, buyer.suspension.cancelAfterSuspension]) expect(mock.mock.calls[0]?.[0].idempotencyKey === key).toBe(true);
    expect(buyer.lateClaims.fileLateClaim.mock.calls[0]?.[0].transferAt instanceof Date).toBe(true);
    const reveal = request(); reveal.headers.delete("idempotency-key"); await code(await f.http.revealRefund(reveal, orderId, childId), 400, "invalid_request");
    expect((await f.http.revealRefund(request(), orderId, childId)).status).toBe(200);
    expect(Object.keys(f.refunds.revealDestination.mock.calls[0]?.[0]).sort()).toEqual(["actor", "obligationId", "requestId"]);
  });
  test("nested command targets must belong to the route's order", async () => {
    const f = fixture("creator"); f.view.getOrderResolution.mockResolvedValue({ role: "creator", proposals: { pending: null, history: [] }, dispute: null, refunds: [], lateClaim: null });
    for (const call of [() => f.http.respondProposal(request({ response: "accept" }), orderId, childId, "creator"), () => f.http.withdrawProposal(request(), orderId, childId, "creator"),
      () => f.http.addStatement(request({ text: "Synthetic statement" }), orderId, childId, "creator"), () => f.http.withdrawDispute(request(), orderId, childId, "creator"),
      () => f.http.revealRefund(request(), orderId, childId), () => f.http.recordRefundSend(request({ expectedVersion: 1, transferDate: "2026-10-08", bankReference: "synthetic-reference" }), orderId, childId),
      () => f.http.answerLateClaim(request({ received: false }), orderId, childId)]) await code(await call(), 404, "not_available");
  });
  test("my cases is a private authenticated read", async () => {
    const f = fixture(); expect((await f.http.myCases(request({}, {}, "GET"))).status).toBe(200); expect(f.view.listMyCases).toHaveBeenCalledWith({ actor });
    f.authenticate.mockResolvedValue(null); await code(await f.http.myCases(request({}, {}, "GET")), 401, "authentication_required");
  });
});
