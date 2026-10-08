import { randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { TrustCaseError } from "@pawket/trust";
import { createCaseHttpHandlers } from "../src/platform/case-http.js";
import { oidcCommand } from "../src/platform/oidc-command-registry.js";
import type { WebPlatformRuntime } from "../src/platform/runtime.js";

const origin = "https://pawket.example.invalid"; const caseId = randomUUID(); const fileId = randomUUID();
const owner = { userId: "synthetic-owner", sessionId: "synthetic-session" };
type Input = Parameters<typeof createCaseHttpHandlers>[0];
function setup() {
  const cases = { listQueue: vi.fn(async () => []), getCase: vi.fn(async () => ({ caseId, orderId: randomUUID(), sourceId: randomUUID(), kind: "dispute", sourceType: "commission_dispute", state: "open", events: [], accessLog: [] })),
    readEvidence: vi.fn(async () => ({})), fileGrant: vi.fn(async () => ({ url: "https://example.invalid/download" })) };
  const commands = { rule: vi.fn(async () => ({})), correctRuling: vi.fn(async () => ({})), postQuestion: vi.fn(async () => ({})), extendDispute: vi.fn(async () => ({})),
    resolveRefundCase: vi.fn(async () => ({})), ruleLateClaim: vi.fn(async () => ({})), freezeFulfillment: vi.fn(async () => ({})) };
  const input = { appBaseUrl: origin, authorizeOwner: vi.fn<Input["authorizeOwner"]>(async () => "authorized"), authenticate: vi.fn(async () => owner),
    issueOwnerStepUpProof: vi.fn(async () => ({ id: randomUUID() })), cases, owner: commands, lateClaims: {}, suspension: {},
    refunds: { readAging: vi.fn(async () => []) }, standing: { readForOrder: vi.fn(async () => "active" as const) },
    orderMetadata: { readForOrder: vi.fn(async () => ({ creatorUserId: "synthetic-creator", buyerUserId: "synthetic-buyer", orderState: "delivered", amountVnd: 500_000 })) },
    resolutionMetadata: { readForCase: vi.fn(async () => ({ disputeOpenedAt: null, respondBy: null, ruling: null })) } } as unknown as Input;
  return { input, cases, commands, http: createCaseHttpHandlers(input) };
}
function request(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/v1/admin/${path}`, { method, headers: { origin, "content-type": "application/json", "idempotency-key": "synthetic-command", ...headers },
    ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}) });
}
const routes = (s: ReturnType<typeof setup>) => [
  () => s.http.queue(request("cases")), () => s.http.detail(request(`cases/${caseId}`), caseId),
  () => s.http.evidence(request(`cases/${caseId}/evidence`, "POST", { section: "order_summary" }), caseId),
  () => s.http.file(request(`cases/${caseId}/files/${fileId}`, "POST", { disposition: "attachment" }), caseId, fileId),
  () => s.http.action(request(`cases/${caseId}/actions`, "POST", { action: "question", text: "Synthetic question", stepUpProofId: "forged-proof" }), caseId),
  () => s.http.freeze(request("creators/synthetic-creator/freeze", "POST", { reason: "Synthetic reason" }), "synthetic-creator"),
  () => s.http.agingRefunds(request("refunds/aging")),
];
describe("owner case HTTP", () => {
  test("a non-owner gets 403 on every case route, including a forged proof, and nothing executes", async () => {
    const s = setup(); vi.mocked(s.input.authorizeOwner).mockResolvedValue("forbidden");
    for (const run of routes(s)) expect((await run()).status).toBe(403);
    for (const fn of [...Object.values(s.cases), ...Object.values(s.commands), s.input.issueOwnerStepUpProof, s.input.refunds.readAging, s.input.standing.readForOrder]) expect(fn).not.toHaveBeenCalled();
  });
  test("unauthenticated gets 401 on every case route", async () => {
    const s = setup(); vi.mocked(s.input.authorizeOwner).mockResolvedValue("unauthenticated");
    for (const run of routes(s)) expect((await run()).status).toBe(401);
    expect(s.cases.getCase).not.toHaveBeenCalled();
  });
  test("an action with an unknown action value returns 400", async () => {
    const s = setup(); expect((await s.http.action(request(`cases/${caseId}/actions`, "POST", { action: "unknown" }), caseId)).status).toBe(400);
    expect(s.input.issueOwnerStepUpProof).not.toHaveBeenCalled();
  });
  test("evidence without step-up returns 403 owner_step_up_required", async () => {
    const s = setup(); s.cases.readEvidence.mockRejectedValue(new TrustCaseError("owner_step_up_required"));
    const response = await s.http.evidence(request(`cases/${caseId}/evidence`, "POST", { section: "order_summary" }), caseId);
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ code: "owner_step_up_required" });
  });
  test("detail returns creator standing without reading private evidence", async () => {
    const s = setup(); const response = await s.http.detail(request(`cases/${caseId}`), caseId);
    expect(response.status).toBe(200); expect((await response.json()).case.creatorStanding).toBe("active");
    expect(s.cases.readEvidence).not.toHaveBeenCalled(); expect(s.cases.fileGrant).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0"); expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
  test("detail derives owner-only order identifiers, state and amount server-side", async () => {
    const s = setup(); const response = await s.http.detail(request(`cases/${caseId}`), caseId);
    expect((await response.json()).case).toMatchObject({ creatorUserId: "synthetic-creator", buyerUserId: "synthetic-buyer", orderState: "delivered", amountVnd: 500_000 });
    expect(s.input.orderMetadata.readForOrder).toHaveBeenCalledWith((await s.cases.getCase.mock.results[0]!.value).orderId);
    expect(s.cases.readEvidence).not.toHaveBeenCalled(); expect(s.input.issueOwnerStepUpProof).not.toHaveBeenCalled();
  });
  test("aging exposes only order ID, amount and age", async () => {
    const s = setup(); vi.mocked(s.input.refunds.readAging).mockResolvedValue([{ obligationId: randomUUID(), orderId: caseId, buyerUserId: "private-buyer", creatorUserId: "creator",
      amountVnd: 100_000, createdAt: new Date(Date.now() - 31 * 86_400_000) }]);
    const response = await s.http.agingRefunds(request("refunds/aging"));
    expect(Object.keys((await response.json()).refunds[0]).sort()).toEqual(["ageDays", "amountVnd", "orderId"]);
  });
  test("rejects cross-site, query parameters, client proof IDs, unknown fields and oversized bodies", async () => {
    const s = setup(); const path = `cases/${caseId}/evidence`;
    expect((await s.http.evidence(request(path, "POST", { section: "order_summary" }, { origin: "https://other.invalid" }), caseId)).status).toBe(403);
    expect((await s.http.evidence(request(`${path}?cursor=1`, "POST", { section: "order_summary" }), caseId)).status).toBe(400);
    expect((await s.http.evidence(request(path, "POST", { section: "order_summary", stepUpProofId: "forged" }), caseId)).status).toBe(400);
    expect((await s.http.evidence(request(path, "POST", { section: "thread_page", cursor: 0 }), caseId)).status).toBe(400);
    expect((await s.http.evidence(request(path, "POST", { section: "order_summary", extra: "x".repeat(65_536) }), caseId)).status).toBe(413);
    expect(s.cases.readEvidence).not.toHaveBeenCalled();
  });
  test.each([
    { action: "rule", method: "rule", kind: "dispute", fields: { outcome: "close", refundAmountVnd: 0, reasoning: "Synthetic reasoning" } },
    { action: "correct", method: "correctRuling", kind: "dispute", fields: { rulingId: fileId, newRefundAmountVnd: 0, reason: "Synthetic reason" } },
    { action: "question", method: "postQuestion", kind: "dispute", fields: { text: "Synthetic question" } },
    { action: "extend", method: "extendDispute", kind: "dispute", fields: { until: "2026-10-10T00:00:00.000Z", reason: "Synthetic reason" } },
    { action: "accept_evidence", method: "resolveRefundCase", kind: "refund_not_received", fields: { reason: "Synthetic reason" } },
    { action: "require_resend", method: "resolveRefundCase", kind: "refund_not_received", fields: { reason: "Synthetic reason" } },
    { action: "waive", method: "resolveRefundCase", kind: "refund_overdue", fields: { reason: "Synthetic reason" } },
    { action: "extend_deadline", method: "resolveRefundCase", kind: "refund_overdue", fields: { until: "2026-10-10T00:00:00.000Z", reason: "Synthetic reason" } },
    { action: "rule_claim", method: "ruleLateClaim", kind: "late_payment", fields: { outcome: "rejected", reason: "Synthetic reason" } },
  ] as const)("dispatches $action with an action-bound server proof", async ({ action, method, kind, fields }) => {
    const s = setup(); const detail = await s.cases.getCase(); detail.kind = kind; s.cases.getCase.mockResolvedValue(detail);
    const response = await s.http.action(request(`cases/${caseId}/actions`, "POST", { action, ...fields }), caseId);
    expect(response.status).toBe(200); expect(s.input.issueOwnerStepUpProof).toHaveBeenCalledWith(expect.objectContaining({ ...owner, actionClass: `owner.case_${action}` }));
    expect(s.commands[method]).toHaveBeenCalledWith(expect.objectContaining({ owner, stepUpProofId: expect.any(String), idempotencyKey: "synthetic-command" }));
    if (["rule", "question", "extend"].includes(action)) expect(s.commands[method]).toHaveBeenCalledWith(expect.objectContaining({ disputeId: detail.sourceId }));
    if (action === "rule_claim") expect(s.commands[method]).toHaveBeenCalledWith(expect.objectContaining({ claimId: detail.sourceId }));
    if ("until" in fields && typeof fields.until === "string") expect(s.commands[method]).toHaveBeenCalledWith(expect.objectContaining({ until: new Date(fields.until) }));
  });
  test.each(["rule", "correct", "question", "extend", "accept_evidence", "require_resend", "waive", "extend_deadline", "rule_claim"])("registry binds %s to a fresh owner action", async (action) => {
    const saved = { method: "POST" as const, path: `/api/v1/admin/cases/${caseId}/actions`, body: JSON.stringify({ action }), idempotencyKey: null, ifMatch: null, returnPath: "/" };
    const entry = oidcCommand(saved); expect(entry?.policy).toEqual({ actionClass: `owner.case_${action}`, fresh: true });
    const handler = vi.fn(async () => new Response()); await entry!.execute({ caseHandlers: { action: handler } } as unknown as WebPlatformRuntime, request(`cases/${caseId}/actions`, "POST"));
    expect(handler).toHaveBeenCalledWith(expect.any(Request), caseId);
    expect(oidcCommand({ ...saved, body: JSON.stringify({ action: "unknown" }) })).toBeNull();
  });
  test.each([
    [`cases/${caseId}/evidence`, "owner.case_evidence", "evidence", [caseId]],
    [`cases/${caseId}/files/${fileId}`, "owner.case_file", "file", [caseId, fileId]],
    ["creators/synthetic-creator/freeze", "owner.commission_fulfillment_freeze", "freeze", ["synthetic-creator"]],
  ] as const)("registry binds %s", async (path, actionClass, name, args) => {
    const entry = oidcCommand({ method: "POST", path: `/api/v1/admin/${path}`, body: "{}", idempotencyKey: null, ifMatch: null, returnPath: "/" });
    expect(entry?.policy).toEqual({ actionClass, fresh: true }); const handler = vi.fn(async () => new Response());
    await entry!.execute({ caseHandlers: { [name]: handler } } as unknown as WebPlatformRuntime, request(path, "POST")); expect(handler).toHaveBeenCalledWith(expect.any(Request), ...args);
  });
});
