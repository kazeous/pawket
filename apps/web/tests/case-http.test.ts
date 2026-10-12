import { randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { TrustCaseError, TrustEnforcementError } from "@pawket/trust";
import { createCaseHttpHandlers } from "../src/platform/case-http.js";
import { oidcCommand } from "../src/platform/oidc-command-registry.js";
import type { WebPlatformRuntime } from "../src/platform/runtime.js";

const origin = "https://pawket.example.invalid"; const caseId = randomUUID(); const fileId = randomUUID();
const owner = { userId: "synthetic-owner", sessionId: "synthetic-session" };
type Input = Parameters<typeof createCaseHttpHandlers>[0];
function setup() {
  const cases = { listQueue: vi.fn(async () => []), getCase: vi.fn(async () => ({ caseId, orderId: randomUUID() as string | null, sourceId: randomUUID(), kind: "dispute", sourceType: "commission_dispute", state: "open", events: [], accessLog: [] })),
    readEvidence: vi.fn(async () => ({})), fileGrant: vi.fn(async () => ({ url: "https://example.invalid/download" })) };
  const commands = { rule: vi.fn(async () => ({})), correctRuling: vi.fn(async () => ({})), postQuestion: vi.fn(async () => ({})), extendDispute: vi.fn(async () => ({})),
    resolveRefundCase: vi.fn(async () => ({})), ruleLateClaim: vi.fn(async () => ({})), freezeFulfillment: vi.fn(async () => ({})) };
  const input = { appBaseUrl: origin, enforcementMode: "enabled", authorizeOwner: vi.fn<Input["authorizeOwner"]>(async () => "authorized"), authenticate: vi.fn(async () => owner),
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
test("public-report penalty uses a server-bound source and fresh action; policy publish uses expected revision", async () => {
  const s = setup(); const penalties = { apply: vi.fn(async () => ({ penaltyId: fileId })), lift: vi.fn(), listActive: vi.fn() };
  const policies = { publish: vi.fn(async () => ({ revisionId: fileId, revisionNumber: 4 })), readCurrent: vi.fn(async () => null) };
  const http = createCaseHttpHandlers({ ...s.input, enforcementMode: "enabled", penalties, policies });
  expect((await http.publicReportPenalty(request(`content-reports/${fileId}/penalty`, "POST", { subjectUserId: "creator", kind: "warning", reasonCategory: "other", explanation: "Reason" }), fileId)).status).toBe(200);
  expect(penalties.apply).toHaveBeenCalledWith(expect.objectContaining({ source: { publicReportId: fileId }, subjectUserId: "creator", owner }));
  expect((await http.publishPolicy(request("policies", "POST", { kind: "community_rules", expectedRevisionNumber: 3, document: "Quy tắc" }))).status).toBe(200);
  expect(policies.publish).toHaveBeenCalledWith(expect.objectContaining({ expectedRevisionNumber: 3, owner }));
  for (const [path, actionClass] of [[`/api/v1/admin/content-reports/${fileId}/penalty`, "owner.trust_penalty_apply"], ["/api/v1/admin/policies", "owner.trust_policy_publish"]]) {
    expect(oidcCommand({ method: "POST", path: path!, body: "{}", idempotencyKey: "key", ifMatch: null, returnPath: "/" })?.policy).toEqual({ actionClass, fresh: true });
  }
});
test("disabled enforcement refuses trust routes before proof or mutation but preserves Stage A", async () => {
  const s = setup(); const penalties = { apply: vi.fn(), lift: vi.fn(), listActive: vi.fn() }; const policies = { publish: vi.fn(), readCurrent: vi.fn() };
  const http = createCaseHttpHandlers({ ...s.input, enforcementMode: "disabled", penalties, policies });
  for (const response of [await http.queue(request("cases?kind=report")), await http.queue(request("cases?kind=appeal")), await http.penalties(request("penalties")), await http.liftPenalty(request(`penalties/${fileId}/lift`, "POST", { reason: "Reason" }), fileId), await http.publishPolicy(request("policies", "POST", {})), await http.publicReportPenalty(request(`content-reports/${fileId}/penalty`, "POST", {}), fileId), await http.action(request(`cases/${caseId}/actions`, "POST", { action: "penalty", subjectUserId: "creator", kind: "warning", reasonCategory: "other", explanation: "Reason" }), caseId)]) {
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ code: "enforcement_disabled" });
  }
  expect(s.input.issueOwnerStepUpProof).not.toHaveBeenCalled(); expect(policies.publish).not.toHaveBeenCalled(); expect(penalties.apply).not.toHaveBeenCalled(); expect(penalties.lift).not.toHaveBeenCalled(); expect(penalties.listActive).not.toHaveBeenCalled();
  expect((await http.detail(request(`cases/${caseId}`), caseId)).status).toBe(200);
});
test.each(["use_penalty", "duplicate", "resolution_disabled"] as const)("case HTTP preserves readable enforcement error %s", async (code) => {
  const s = setup(); const penalties = { apply: vi.fn().mockRejectedValue(new TrustEnforcementError(code)), lift: vi.fn(), listActive: vi.fn() };
  const response = await createCaseHttpHandlers({ ...s.input, enforcementMode: "enabled", penalties }).publicReportPenalty(request(`content-reports/${fileId}/penalty`, "POST", { subjectUserId: "creator", kind: "warning", reasonCategory: "other", explanation: "Reason" }), fileId);
  expect(response.status).toBe(code === "resolution_disabled" ? 503 : 409); expect(await response.json()).toEqual({ code });
});
test("disabled detail, evidence and file routes refuse trust cases, including legacy evidence sections", async () => {
  const s = setup(); s.cases.getCase.mockResolvedValue({ ...await s.cases.getCase(), kind: "report", orderId: null });
  const http = createCaseHttpHandlers({ ...s.input, enforcementMode: "disabled" });
  for (const response of [await http.detail(request(`cases/${caseId}`), caseId), await http.evidence(request(`cases/${caseId}/evidence`, "POST", { section: "report_context" }), caseId), await http.evidence(request(`cases/${caseId}/evidence`, "POST", { section: "order_summary" }), caseId), await http.file(request(`cases/${caseId}/files/${fileId}`, "POST", { disposition: "attachment" }), caseId, fileId)]) expect(response.status).toBe(503);
  expect(s.cases.readEvidence).not.toHaveBeenCalled(); expect(s.cases.fileGrant).not.toHaveBeenCalled(); expect(s.input.issueOwnerStepUpProof).not.toHaveBeenCalled();
});
test("disabled mixed queue fills a legacy page across hidden trust cases", async () => {
  const s = setup(); const row = { ...await s.cases.getCase(), state: "open" as const, version: 1, resolutionKind: null, policyRevisionId: null, communityPolicyRevisionId: null, enforcementPolicyRevisionId: null, resolvedAt: null, openedAt: "2026-10-07T00:00:00.000Z", nextDeadline: null };
  vi.mocked(s.input.cases.listQueue).mockResolvedValueOnce([{ ...row, kind: "report" }, { ...row, kind: "dispute" }]).mockResolvedValueOnce([{ ...row, kind: "appeal" }, { ...row, caseId: fileId, kind: "late_payment" }]).mockResolvedValueOnce([]);
  const http = createCaseHttpHandlers({ ...s.input, enforcementMode: "disabled" });
  expect((await (await http.queue(request("cases?limit=2"))).json()).cases.map((item: { kind: string }) => item.kind)).toEqual(["dispute", "late_payment"]);
  expect(s.cases.listQueue).toHaveBeenCalledTimes(2);
});
test("new owner routes reject non-owner, cross-origin, queries and forged source/proof before dispatch", async () => {
  const s = setup(); const penalties = { apply: vi.fn(), lift: vi.fn(), listActive: vi.fn() }; const policies = { publish: vi.fn(), readCurrent: vi.fn() }; const trustMetadata = { readForCase: vi.fn(), publicReportParties: vi.fn() };
  const http = createCaseHttpHandlers({ ...s.input, enforcementMode: "enabled", penalties, policies, trustMetadata });
  const body = { subjectUserId: "creator", kind: "warning", reasonCategory: "other", explanation: "Reason" };
  for (const extra of [{ source: { publicReportId: caseId } }, { stepUpProofId: caseId }]) expect((await http.publicReportPenalty(request(`content-reports/${fileId}/penalty`, "POST", { ...body, ...extra }), fileId)).status).toBe(400);
  expect((await http.publicReportPenalty(request(`content-reports/${fileId}/penalty`, "POST", body, { origin: "https://other.invalid" }), fileId)).status).toBe(403);
  expect((await http.publishPolicy(request("policies?kind=community_rules", "POST", { kind: "community_rules", expectedRevisionNumber: 0, document: "Rules" }))).status).toBe(400);
  vi.mocked(s.input.authorizeOwner).mockResolvedValue("forbidden");
  for (const response of [await http.publicReportPenalty(request(`content-reports/${fileId}/penalty`, "POST", body), fileId), await http.publicReportParties(request(`content-reports/${fileId}/penalty`), fileId), await http.policies(request("policies")), await http.publishPolicy(request("policies", "POST", {}))]) expect(response.status).toBe(403);
  for (const fn of [...Object.values(penalties), ...Object.values(policies), ...Object.values(trustMetadata), s.input.issueOwnerStepUpProof]) expect(fn).not.toHaveBeenCalled();
});
describe("owner case HTTP", () => {
  test("appeal decision dispatches expected version and server-issued action proof for an orderless appeal", async () => {
    const s = setup(); const decide = vi.fn(async () => undefined);
    s.cases.getCase.mockResolvedValue({ ...await s.cases.getCase(), kind: "appeal", sourceType: "trust_appeal", orderId: null });
    const http = createCaseHttpHandlers({ ...s.input, appeals: { decide } });
    const body = { action: "decide_appeal", decision: "reduced", expectedCaseVersion: 1, reasoning: "Xin xem lại",
      replacement: { kind: "restriction", restriction: "reporting", endsAt: null } };
    expect((await http.action(request(`cases/${caseId}/actions`, "POST", body), caseId)).status).toBe(200);
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ owner, caseId, decision: "reduced", expectedCaseVersion: 1, replacement: body.replacement }));
    expect(s.input.issueOwnerStepUpProof).toHaveBeenCalledWith(expect.objectContaining({ actionClass: "owner.trust_appeal_decide" }));
    expect(s.input.orderMetadata.readForOrder).not.toHaveBeenCalled();
    expect((await http.action(request(`cases/${caseId}/actions`, "POST", { ...body, stepUpProofId: fileId }), caseId)).status).toBe(400);
    vi.mocked(s.input.authorizeOwner).mockResolvedValue("forbidden");
    expect((await http.action(request(`cases/${caseId}/actions`, "POST", body), caseId)).status).toBe(403);
    expect(decide).toHaveBeenCalledOnce();
  });
  test.each(["dispute", "report", "late_payment", "refund_overdue", "refund_not_received", "appeal"])("penalty dispatch accepts %s cases and binds source/proof server-side", async (kind) => {
    const s = setup(); s.cases.getCase.mockResolvedValue({ ...await s.cases.getCase(), kind, orderId: null });
    const apply = vi.fn(async () => ({ penaltyId: fileId }));
    const http = createCaseHttpHandlers({ ...s.input, penalties: { apply } as unknown as NonNullable<Input["penalties"]> });
    expect((await http.action(request(`cases/${caseId}/actions`, "POST", { action: "penalty", subjectUserId: "subject", kind: "warning", reasonCategory: "other", explanation: "Private explanation" }), caseId)).status).toBe(200);
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ owner, source: { caseId }, subjectUserId: "subject", kind: "warning" }));
    expect(s.input.issueOwnerStepUpProof).toHaveBeenCalledWith(expect.objectContaining({ actionClass: "owner.trust_penalty_apply" }));
  });
  test("penalty list and lift require owner authorization, reject forged proofs, and register the exact fresh action", async () => {
    const s = setup(); const lift = vi.fn(async () => undefined); const listActive = vi.fn(async () => []);
    const http = createCaseHttpHandlers({ ...s.input, penalties: { lift, listActive } as unknown as NonNullable<Input["penalties"]> });
    expect((await http.penalties(request("penalties?limit=20"))).status).toBe(200); expect(listActive).toHaveBeenCalledWith({ limit: 20 });
    expect((await http.liftPenalty(request(`penalties/${fileId}/lift`, "POST", { reason: "Lift" }), fileId)).status).toBe(200);
    expect(lift).toHaveBeenCalledWith(expect.objectContaining({ owner, penaltyId: fileId, reason: "Lift" }));
    expect(s.input.issueOwnerStepUpProof).toHaveBeenCalledWith(expect.objectContaining({ actionClass: "owner.trust_penalty_lift" }));
    expect((await http.liftPenalty(request(`penalties/${fileId}/lift`, "POST", { reason: "Lift", stepUpProofId: "forged" }), fileId)).status).toBe(400);
    vi.mocked(s.input.authorizeOwner).mockResolvedValue("forbidden"); expect((await http.penalties(request("penalties"))).status).toBe(403);
    expect((await http.liftPenalty(request(`penalties/${fileId}/lift`, "POST", { reason: "Lift" }), fileId)).status).toBe(403);
    const payload = { method: "POST" as const, body: "{}", idempotencyKey: null, ifMatch: null, returnPath: "/" };
    expect(oidcCommand({ ...payload, path: `/api/v1/admin/penalties/${fileId}/lift` })?.policy).toEqual({ actionClass: "owner.trust_penalty_lift", fresh: true });
    expect(oidcCommand({ ...payload, body: JSON.stringify({ action: "penalty" }), path: `/api/v1/admin/cases/${caseId}/actions` })?.policy).toEqual({ actionClass: "owner.trust_penalty_apply", fresh: true });
  });
  test.each([
    ["hide", "owner.trust_hide", { reason: "Private reason" }, "hide"],
    ["restore", "owner.trust_restore", { hideId: fileId, reason: "Private reason" }, "restore"],
    ["close_report", "owner.trust_report_close", { resolution: "dismissed", reason: "Private reason" }, "closeReportCase"],
  ] as const)("orderless report %s is dispatched with its own fresh action and expected version", async (action, actionClass, fields, method) => {
    const s = setup(); const detail = { ...await s.cases.getCase(), kind: "report", sourceType: "commission_package", orderId: null, version: 2 };
    s.cases.getCase.mockResolvedValue(detail);
    const contentHides = { hide: vi.fn(async () => ({ hideId: fileId })), restore: vi.fn(async () => undefined), closeReportCase: vi.fn(async () => undefined) };
    const http = createCaseHttpHandlers({ ...s.input, contentHides });
    expect((await http.detail(request(`cases/${caseId}`), caseId)).status).toBe(200);
    expect(s.input.orderMetadata.readForOrder).not.toHaveBeenCalled();
    const response = await http.action(request(`cases/${caseId}/actions`, "POST", { action, expectedCaseVersion: 2, ...fields }), caseId);
    expect(response.status).toBe(200); expect(contentHides[method]).toHaveBeenCalledWith(expect.objectContaining({ owner, caseId, expectedCaseVersion: 2, ...fields }));
    expect(s.input.issueOwnerStepUpProof).toHaveBeenCalledWith(expect.objectContaining({ actionClass }));
    expect(oidcCommand({ method: "POST", path: `/api/v1/admin/cases/${caseId}/actions`, body: JSON.stringify({ action }), idempotencyKey: null, ifMatch: null, returnPath: "/" })?.policy).toEqual({ actionClass, fresh: true });
  });
  test.each(["report_context", "package_revision", "brief"])("HTTP accepts report evidence section %s", async (section) => {
    const s = setup(); expect((await s.http.evidence(request(`cases/${caseId}/evidence`, "POST", { section }), caseId)).status).toBe(200);
    expect(s.cases.readEvidence).toHaveBeenCalledWith(expect.objectContaining({ section }));
  });
  test.each(["detail", "action"] as const)("%s refuses null order metadata before reading order ports or issuing a proof", async (route) => {
    const s = setup(); const detail = await s.cases.getCase(); detail.orderId = null; s.cases.getCase.mockResolvedValue(detail);
    const response = route === "detail" ? await s.http.detail(request(`cases/${caseId}`), caseId)
      : await s.http.action(request(`cases/${caseId}/actions`, "POST", { action: "question", text: "Synthetic question" }), caseId);
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ code: "not_available" });
    expect(s.input.orderMetadata.readForOrder).not.toHaveBeenCalled(); expect(s.input.resolutionMetadata.readForCase).not.toHaveBeenCalled();
    expect(s.input.standing.readForOrder).not.toHaveBeenCalled(); expect(s.input.issueOwnerStepUpProof).not.toHaveBeenCalled();
    for (const fn of Object.values(s.commands)) expect(fn).not.toHaveBeenCalled();
  });
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
  test.each(["different", "missing"])("a correction with a %s case ruling returns 404 without issuing a proof or executing", async (kind) => {
    const s = setup(); const detail = await s.cases.getCase(); detail.state = "resolved"; s.cases.getCase.mockResolvedValue(detail);
    vi.mocked(s.input.resolutionMetadata.readForCase).mockResolvedValue({ disputeOpenedAt: null, respondBy: null,
      ruling: kind === "missing" ? null : { id: randomUUID(), outcome: "close", refundAmountVnd: 100_000, currentRefundAmountVnd: 100_000, correctedAt: null, ruledAt: "2026-10-08T00:00:00.000Z", correctionEndsAt: null } });
    const response = await s.http.action(request(`cases/${caseId}/actions`, "POST", { action: "correct", rulingId: fileId, newRefundAmountVnd: 0, reason: "Synthetic reason" }), caseId);
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ code: "not_available" });
    expect(s.input.resolutionMetadata.readForCase).toHaveBeenCalledWith(detail);
    expect(s.input.issueOwnerStepUpProof).not.toHaveBeenCalled();
    for (const fn of Object.values(s.commands)) expect(fn).not.toHaveBeenCalled();
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
    if (action === "correct") vi.mocked(s.input.resolutionMetadata.readForCase).mockResolvedValue({ disputeOpenedAt: null, respondBy: null,
      ruling: { id: fileId, outcome: "close", refundAmountVnd: 100_000, currentRefundAmountVnd: 100_000, correctedAt: null, ruledAt: "2026-10-08T00:00:00.000Z", correctionEndsAt: null } });
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
