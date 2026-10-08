import { randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { createOwnerResolutionService, type ResolutionOwnerCommand } from "../src/index.js";
import type { createResolutionCommandKit } from "../src/command-kit.js";
import type { ResolutionOrderPort, ResolutionRefundPort, ResolutionPaymentFactsPort, ResolutionCasePort } from "../src/ports.js";

const disputeId = randomUUID(); const rulingId = randomUUID(); const caseId = randomUUID(); const recordedId = randomUUID();
const at = new Date("2026-10-09T04:00:00Z");
const base = (): ResolutionOwnerCommand => ({ owner: { userId: "synthetic-owner", sessionId: "synthetic-session" },
  stepUpProofId: randomUUID(), idempotencyKey: randomUUID(), requestId: randomUUID() });
function setup() {
  const kit: ReturnType<typeof createResolutionCommandKit> = { mutate: vi.fn(),
    ownerMutate: vi.fn(async (_command, scope) => scope === "case_correct" ? `${recordedId}:recorded_only` : recordedId),
    now: () => new Date(at), encrypt: vi.fn(), decrypt: vi.fn() };
  const orders: ResolutionOrderPort = { lockOrder: vi.fn(), closePaidOrder: vi.fn(), completeByResolution: vi.fn(), restoreReviewTime: vi.fn(), completionDueAt: vi.fn(), listLiveOrders: vi.fn() };
  const refunds: ResolutionRefundPort = { createObligation: vi.fn(), adjustAmount: vi.fn(), waive: vi.fn(), extendDeadline: vi.fn(), acceptReceiptEvidence: vi.fn(), requireResend: vi.fn(), awaitingSendDeadlines: vi.fn(), listForOrder: vi.fn() };
  const payments: ResolutionPaymentFactsPort = { paidIntent: vi.fn(), closedIntent: vi.fn() };
  const cases: ResolutionCasePort = { readCase: vi.fn(), openCase: vi.fn(), resolveCase: vi.fn(), recordCaseEvent: vi.fn(), findOpenCase: vi.fn() };
  const input = { orders, refunds, payments, cases, mode: "enabled" as const, applicationRevision: "synthetic-i8" };
  return { kit, input, service: createOwnerResolutionService(kit, input) };
}
const rule = () => ({ ...base(), disputeId, outcome: "complete" as const, refundAmountVnd: 200_000, reasoning: "Synthetic reasoning" });
describe("owner resolution command boundaries", () => {
  test.each([NaN, Infinity, -1, 0.5, 50_000_001])("invalid amount %s never reaches ownerMutate", async (amount) => {
    const p = setup();
    await expect(p.service.rule({ ...rule(), refundAmountVnd: amount })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(p.service.correctRuling({ ...base(), rulingId, newRefundAmountVnd: amount, reason: "Synthetic correction" })).rejects.toMatchObject({ code: "invalid_request" });
    expect(p.kit.ownerMutate).not.toHaveBeenCalled();
  });
  test.each(["", "x".repeat(4_001), "synthetic\t", "synthetic\u202e", "\ud800"])("invalid reasoning case %# never reaches ownerMutate", async (reasoning) => {
    const p = setup(); await expect(p.service.rule({ ...rule(), reasoning })).rejects.toMatchObject({ code: "invalid_request" }); expect(p.kit.ownerMutate).not.toHaveBeenCalled();
  });
  test("optional internal note may be empty but must fit its bound", async () => {
    const p = setup(); await p.service.rule({ ...rule(), internalNote: "" });
    await expect(p.service.rule({ ...rule(), internalNote: "x".repeat(2_001) })).rejects.toMatchObject({ code: "invalid_request" });
    expect(p.kit.ownerMutate).toHaveBeenCalledTimes(1);
  });
  test("extra fields, accessors and proxies are rejected without evaluation", async () => {
    const p = setup(); const getter = vi.fn(() => "Synthetic reasoning");
    await expect(p.service.rule({ ...rule(), get reasoning() { return getter(); } })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(p.service.rule({ ...rule(), extra: true } as ReturnType<typeof rule>)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(p.service.rule(new Proxy(rule(), {}))).rejects.toMatchObject({ code: "invalid_request" });
    expect(getter).not.toHaveBeenCalled(); expect(p.kit.ownerMutate).not.toHaveBeenCalled();
  });
  test("each owner command supplies the exact action class and target id in its fingerprint payload", async () => {
    const p = setup(); await p.service.rule({ ...rule(), reasoning: " e\u0301 " });
    await p.service.correctRuling({ ...base(), rulingId, newRefundAmountVnd: 100_000, reason: "Synthetic correction" });
    await p.service.postQuestion({ ...base(), disputeId, text: "Synthetic question" });
    await p.service.extendDispute({ ...base(), disputeId, until: at, reason: "Synthetic extension" });
    for (const action of ["accept_evidence", "require_resend", "waive", "extend_deadline"] as const)
      await p.service.resolveRefundCase({ ...base(), caseId, action, reason: "Synthetic refund", ...(action === "extend_deadline" ? { until: at } : {}) });
    const calls = vi.mocked(p.kit.ownerMutate).mock.calls;
    expect(calls.map((args) => args[4])).toEqual(["owner.case_rule", "owner.case_correct", "owner.case_question", "owner.case_extend",
      "owner.case_accept_evidence", "owner.case_require_resend", "owner.case_waive", "owner.case_extend_deadline"]);
    expect(calls.map((args) => (args[2] as readonly unknown[])[0])).toEqual([disputeId, rulingId, disputeId, disputeId, caseId, caseId, caseId, caseId]);
    expect((calls[0]![2] as readonly unknown[])[3]).toBe("é");
  });
  test.each(["rule", "correct", "question", "extend", "refund"] as const)("disabled mode refuses %s before ownerMutate", async (method) => {
    const p = setup(); const service = createOwnerResolutionService(p.kit, { ...p.input, mode: "disabled" });
    await expect(method === "rule" ? service.rule(rule()) : method === "correct" ? service.correctRuling({ ...base(), rulingId, newRefundAmountVnd: 0, reason: "Synthetic correction" })
      : method === "question" ? service.postQuestion({ ...base(), disputeId, text: "Synthetic question" })
      : method === "extend" ? service.extendDispute({ ...base(), disputeId, until: at, reason: "Synthetic extension" })
      : service.resolveRefundCase({ ...base(), caseId, action: "waive", reason: "Synthetic refund" })).rejects.toMatchObject({ code: "resolution_disabled" });
    expect(p.kit.ownerMutate).not.toHaveBeenCalled();
  });
  test("refund until is required only for extend_deadline and invalid dates are refused", async () => {
    const p = setup(); const command = { ...base(), caseId, action: "extend_deadline" as const, reason: "Synthetic refund" };
    await expect(p.service.resolveRefundCase(command)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(p.service.resolveRefundCase({ ...command, until: new Date(NaN) })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(p.service.resolveRefundCase({ ...command, action: "waive", until: at })).rejects.toMatchObject({ code: "invalid_request" });
    expect(p.kit.ownerMutate).not.toHaveBeenCalled();
  });
  test.each(["bad", `${recordedId}:unknown`, `${recordedId}:waived:extra`])("invalid correction result case %# is unavailable", async (reference) => {
    const p = setup(); vi.mocked(p.kit.ownerMutate).mockResolvedValue(reference);
    await expect(p.service.correctRuling({ ...base(), rulingId, newRefundAmountVnd: 0, reason: "Synthetic correction" })).rejects.toMatchObject({ code: "dependency_unavailable" });
  });
});
