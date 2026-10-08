import { randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { commissionProposals, completeIdempotentCommand, systemOutbox, type PawketTransaction } from "@pawket/database";
import type { CommissionResolutionOrderFacts } from "@pawket/orders";
import { createProposalService, type CommissionProposal } from "../src/index.js";
import type { createResolutionCommandKit } from "../src/command-kit.js";
import type { ResolutionOrderPort, ResolutionRefundPort, ResolutionPaymentFactsPort, ResolutionCasePort } from "../src/ports.js";

const actor = { userId: "synthetic-buyer", sessionId: "synthetic-session" };
const orderId = randomUUID(); const proposalId = randomUUID(); const at = new Date("2026-10-09T04:00:00Z");
const command = () => ({ actor, orderId, expectedVersion: 2, kind: "cancel_with_refund" as const, refundAmountVnd: 1,
  note: "Synthetic note", idempotencyKey: randomUUID(), requestId: randomUUID() });
function setup() {
  const facts: CommissionResolutionOrderFacts = { id: orderId, version: 2, state: "in_progress", creatorUserId: "synthetic-creator",
    buyerUserId: actor.userId, amountVnd: 500_000, acceptedAt: at, confirmedAt: at, dueAt: at, deliveredAt: null,
    reviewEndsAt: null, completionFloorAt: null, closedAt: null, closeReason: null, policyRevisionId: null };
  const orders: ResolutionOrderPort = { lockOrder: vi.fn(async () => facts), closePaidOrder: vi.fn(), completeByResolution: vi.fn(),
    restoreReviewTime: vi.fn(), completionDueAt: vi.fn(), listLiveOrders: vi.fn() };
  const refunds: ResolutionRefundPort = { createObligation: vi.fn(), adjustAmount: vi.fn(), waive: vi.fn(), extendDeadline: vi.fn(),
    acceptReceiptEvidence: vi.fn(), requireResend: vi.fn(), awaitingSendDeadlines: vi.fn(), listForOrder: vi.fn() };
  const payments: ResolutionPaymentFactsPort = { paidIntent: vi.fn(), closedIntent: vi.fn() };
  const cases: ResolutionCasePort = { openCase: vi.fn(), resolveCase: vi.fn(), recordCaseEvent: vi.fn(), findOpenCase: vi.fn() };
  // These tests isolate boundary validation, target authorization and recorded results; integration tests exercise writes.
  const kit: ReturnType<typeof createResolutionCommandKit> = { mutate: vi.fn(async (_command, scope) => scope === "propose"
    ? proposalId : `${proposalId}:3`), ownerMutate: vi.fn(),
    encrypt: vi.fn(), decrypt: vi.fn(), now: () => new Date(at) };
  const service = createProposalService(kit, { orders, refunds, payments, cases, mode: "enabled" });
  return { service, kit, orders, facts, refunds, payments, cases };
}
describe("proposal command validation and replay boundaries", () => {
  test.each([NaN, Infinity, -1, 1.5, 50_000_001])("invalid integer amount %s never reaches mutate", async (amount) => {
    const p = setup(); await expect(p.service.propose({ ...command(), refundAmountVnd: amount })).rejects.toMatchObject({ code: "invalid_request" });
    expect(p.kit.mutate).not.toHaveBeenCalled();
  });
  test.each(["", "x".repeat(2_001), "synthetic\u202e", "synthetic\t", "\ud800"])("invalid note case %# never reaches mutate", async (note) => {
    const p = setup(); await expect(p.service.propose({ ...command(), note })).rejects.toMatchObject({ code: "invalid_request" });
    expect(p.kit.mutate).not.toHaveBeenCalled();
  });
  test("a maximum-length emoji note is normalized and the order is part of the payload", async () => {
    const p = setup(); const input = { ...command(), note: ` ${"\u{1f600}".repeat(2_000)} ` };
    expect(await p.service.propose(input)).toEqual({ proposalId });
    const args = vi.mocked(p.kit.mutate).mock.calls[0]!;
    expect(JSON.stringify(args[2]).includes(orderId)).toBe(true);
    expect(JSON.stringify(args[2]).includes(input.note.trim())).toBe(true);
  });
  test("accessors and extra command fields are rejected without evaluating them", async () => {
    const p = setup(); const getter = vi.fn(() => "Synthetic note");
    await expect(p.service.propose({ ...command(), get note() { return getter(); } })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(p.service.propose({ ...command(), extra: true } as ReturnType<typeof command>)).rejects.toMatchObject({ code: "invalid_request" });
    expect(getter).not.toHaveBeenCalled(); expect(p.kit.mutate).not.toHaveBeenCalled();
  });
  test.each(["propose", "respond", "withdraw"] as const)("disabled mode rejects %s before mutate", async (action) => {
    const p = setup(); const service = createProposalService(p.kit, { ...p, mode: "disabled" });
    const input = { actor, proposalId, idempotencyKey: randomUUID(), requestId: randomUUID() };
    await expect(action === "propose" ? service.propose(command()) : action === "respond"
      ? service.respondToProposal({ ...input, response: "accept" }) : service.withdrawProposal(input)).rejects.toMatchObject({ code: "resolution_disabled" });
    expect(p.kit.mutate).not.toHaveBeenCalled();
  });
  test("creatorOf authorizes the order target each time the kit invokes it", async () => {
    const p = setup(); await p.service.propose(command()); const creatorOf = vi.mocked(p.kit.mutate).mock.calls[0]![3];
    const tx = {} as PawketTransaction;
    expect(await creatorOf(tx)).toBe(p.facts.creatorUserId);
    vi.mocked(p.orders.lockOrder).mockResolvedValue({ ...p.facts, buyerUserId: "synthetic-unrelated" });
    await expect(creatorOf(tx)).rejects.toMatchObject({ code: "not_available" });
  });
  test.each(["respond", "withdraw"] as const)("%s includes proposalId and returns a recorded result", async (action) => {
    const p = setup(); const input = { actor, proposalId, idempotencyKey: randomUUID(), requestId: randomUUID() };
    const result = action === "respond" ? await p.service.respondToProposal({ ...input, response: "decline" }) : await p.service.withdrawProposal(input);
    expect(result).toEqual({ proposalId, orderVersion: 3 });
    expect(JSON.stringify(vi.mocked(p.kit.mutate).mock.calls[0]![2]).includes(proposalId)).toBe(true);
  });
});

// A small transaction double lets the actual service callbacks run while Postgres is offline.
// Port calls are observable; schema guards, races, rollback and real file access remain integration checks.
function scenario(options: { delivered?: boolean; proposer?: "buyer" | "creator"; remainingMs?: number; count?: number; empty?: boolean } = {}) {
  const p = setup(); const creator = { userId: p.facts.creatorUserId, sessionId: "synthetic-creator-session" };
  const buyer = actor; const delivered = options.delivered ?? false;
  const order = { ...p.facts, state: delivered ? "delivered" as const : "in_progress" as const,
    deliveredAt: delivered ? at : null, reviewEndsAt: delivered ? new Date(at.getTime() + 7 * 86_400_000) : null };
  vi.mocked(p.orders.lockOrder).mockResolvedValue(order);
  vi.mocked(p.orders.completionDueAt).mockResolvedValue(order.reviewEndsAt);
  vi.mocked(p.orders.closePaidOrder).mockResolvedValue({ version: 3 });
  vi.mocked(p.orders.completeByResolution).mockResolvedValue({ version: 3 });
  vi.mocked(p.orders.restoreReviewTime).mockResolvedValue({ version: 3 });
  vi.mocked(p.payments.paidIntent).mockResolvedValue({ paymentIntentId: randomUUID(), amountVnd: 500_000 });
  const proposer = options.proposer === "creator" ? creator : buyer;
  let row: CommissionProposal | null = options.empty ? null : { id: proposalId, orderId, proposerUserId: proposer.userId,
    proposerRole: options.proposer ?? "buyer", kind: "cancel_with_refund", refundAmountVnd: 250_000,
    noteEnvelope: {} as CommissionProposal["noteEnvelope"], orderStateAtCreation: order.state,
    remainingReviewMs: delivered ? options.remainingMs ?? 10 * 3_600_000 : null, state: "pending",
    respondBy: new Date(at.getTime() + 259_200_000), createdAt: at, endedAt: null, endedByUserId: null,
    actorSessionId: proposer.sessionId, requestId: randomUUID(), version: 1 };
  const events: { eventType: string; payload: unknown }[] = [];
  function query(rows: unknown[]) {
    const promise = Promise.resolve(rows);
    const chain = { where: () => chain, limit: () => chain, for: () => chain, orderBy: () => chain, returning: () => chain, then: promise.then.bind(promise) };
    return chain;
  }
  const tx = {
    select: (selection?: { count?: unknown }) => ({ from: (table: unknown) => query(table === commissionProposals
      ? selection?.count ? [{ count: options.count ?? 0 }] : row ? [row] : [] : []) }),
    insert: (table: unknown) => ({ values: (values: CommissionProposal & { eventType: string; payload: unknown }) => {
      if (table === commissionProposals) row = { ...values, state: "pending", endedAt: null, endedByUserId: null, version: 1 };
      if (table === systemOutbox) events.push({ eventType: values.eventType, payload: values.payload });
      return query([{ id: randomUUID() }]);
    } }),
    update: (table: unknown) => ({ set: (values: Partial<CommissionProposal>) => {
      if (table === commissionProposals && row) row = { ...row, ...values };
      return query(row ? [row] : []);
    } }),
  } as unknown as PawketTransaction;
  vi.mocked(p.kit.mutate).mockImplementation(async (_command, _scope, _payload, creatorOf, apply) => {
    await creatorOf(tx); return (await apply(tx)).resultReference;
  });
  const answer = (response: "accept" | "decline" = "accept", requested = options.proposer === "creator" ? buyer : creator) =>
    ({ actor: requested, proposalId, response, idempotencyKey: randomUUID(), requestId: randomUUID() });
  return { ...p, buyer, creator, proposer, order, tx, events, row: () => row!, answer,
    setRow: (values: Partial<CommissionProposal>) => { row = { ...row!, ...values }; } };
}
describe("proposal outcomes through the transaction ports", () => {
  test.each(["propose", "accept", "stale"] as const)("%s records a result reference accepted by the real idempotency helper", async (action) => {
    const p = scenario({ empty: action === "propose" });
    if (action === "propose") await p.service.propose(command());
    else if (action === "accept") await p.service.respondToProposal(p.answer());
    else {
      vi.mocked(p.orders.lockOrder).mockResolvedValue({ ...p.order, state: "delivered" });
      await expect(p.service.respondToProposal(p.answer())).rejects.toMatchObject({ code: "proposal_stale" });
    }
    const resultReference = await vi.mocked(p.kit.mutate).mock.results[0]!.value;
    await expect(completeIdempotentCommand(p.tx, { recordId: randomUUID(), resultReference })).resolves.toBe(true);
  });
  test.each(["buyer", "creator"] as const)("the other party accepts %s cancellation with one agreement obligation", async (proposer) => {
    const p = scenario({ proposer }); const answer = p.answer();
    expect(await p.service.respondToProposal(answer)).toEqual({ proposalId, orderVersion: 3 });
    expect(p.orders.closePaidOrder).toHaveBeenCalledWith(p.tx, { orderId, expectedVersion: 2, reason: "cancelled_by_agreement", actor: answer.actor, requestId: answer.requestId, at });
    expect(p.refunds.createObligation).toHaveBeenCalledOnce();
    expect(p.refunds.createObligation).toHaveBeenCalledWith(p.tx, expect.objectContaining({ orderId, source: "agreement", sourceId: proposalId, amountVnd: 250_000 }));
    expect(p.row()).toMatchObject({ state: "accepted", endedAt: at, endedByUserId: answer.actor.userId, version: 2 });
    expect(p.events).toEqual([{ eventType: "resolution.proposal_ended.v1", payload: { proposalId, orderId, state: "accepted" } }]);
  });
  test("zero cancellation skips the refund port", async () => {
    const p = scenario(); p.setRow({ refundAmountVnd: 0 }); await p.service.respondToProposal(p.answer());
    expect(p.refunds.createObligation).not.toHaveBeenCalled(); expect(p.orders.closePaidOrder).toHaveBeenCalledOnce();
  });
  test("completion by agreement calls the completion port", async () => {
    const p = scenario({ delivered: true }); p.setRow({ kind: "complete_with_refund", refundAmountVnd: 1 });
    await p.service.respondToProposal(p.answer());
    expect(p.orders.completeByResolution).toHaveBeenCalledWith(p.tx, expect.objectContaining({ orderId, expectedVersion: 2, kind: "agreement" }));
    expect(p.orders.closePaidOrder).not.toHaveBeenCalled(); expect(p.row().state).toBe("accepted");
  });
  test("P3 lapses a moved order, records that result and does not create an obligation", async () => {
    const p = scenario(); vi.mocked(p.orders.lockOrder).mockResolvedValue({ ...p.order, state: "delivered", deliveredAt: at, reviewEndsAt: new Date(at.getTime() + 86_400_000) });
    await expect(p.service.respondToProposal(p.answer())).rejects.toMatchObject({ code: "proposal_stale" });
    expect(p.row().state).toBe("lapsed"); expect(p.orders.closePaidOrder).not.toHaveBeenCalled();
    expect(p.refunds.createObligation).not.toHaveBeenCalled(); expect(p.orders.restoreReviewTime).not.toHaveBeenCalled();
  });
  test.each([10 * 3_600_000, 5 * 86_400_000])("decline restores max(remaining, 48 hours) for %i ms", async (remainingMs) => {
    const p = scenario({ delivered: true, remainingMs }); const answer = p.answer("decline");
    expect(await p.service.respondToProposal(answer)).toEqual({ proposalId, orderVersion: 3 });
    expect(p.orders.restoreReviewTime).toHaveBeenCalledWith(p.tx, { orderId, expectedVersion: 2,
      floorAt: new Date(at.getTime() + Math.max(remainingMs, 172_800_000)), actor: answer.actor, requestId: answer.requestId, at });
    expect(p.row().state).toBe("declined");
  });
  test("withdrawal uses the same restoration and preserves a no-op order version from R5", async () => {
    const p = scenario({ delivered: true }); vi.mocked(p.orders.restoreReviewTime).mockResolvedValue({ version: 2 });
    expect(await p.service.withdrawProposal({ actor: p.proposer, proposalId, idempotencyKey: randomUUID(), requestId: randomUUID() })).toEqual({ proposalId, orderVersion: 2 });
    expect(p.orders.restoreReviewTime).toHaveBeenCalledOnce(); expect(p.row().state).toBe("withdrawn");
  });
  test.each(["expired", "lapsed"] as const)("the maintenance helper ends %s and restores delivered review time", async (state) => {
    const p = scenario({ delivered: true }); await p.service.endProposalWithoutAgreement(p.tx, p.row(), state, at, null, randomUUID());
    expect(p.row()).toMatchObject({ state, endedByUserId: null }); expect(p.orders.restoreReviewTime).toHaveBeenCalledOnce();
  });
  test("the maintenance helper does not restore review after the order leaves delivered", async () => {
    const p = scenario({ delivered: true }); vi.mocked(p.orders.lockOrder).mockResolvedValue({ ...p.order, state: "in_progress" });
    await p.service.endProposalWithoutAgreement(p.tx, p.row(), "lapsed", at, null, randomUUID());
    expect(p.orders.restoreReviewTime).not.toHaveBeenCalled();
  });
  test("a deadline at the boundary refuses acceptance before any write", async () => {
    const p = scenario(); p.setRow({ respondBy: at });
    await expect(p.service.respondToProposal(p.answer())).rejects.toMatchObject({ code: "deadline_passed" });
    expect(p.row().state).toBe("pending"); expect(p.events).toHaveLength(0); expect(p.orders.closePaidOrder).not.toHaveBeenCalled();
  });
  test.each(["accept", "decline"] as const)("the proposer cannot %s their own proposal", async (answer) => {
    const p = scenario(); await expect(p.service.respondToProposal(p.answer(answer, p.proposer))).rejects.toMatchObject({ code: "not_available" });
    expect(p.row().state).toBe("pending");
  });
  test.each([0, 500_000])("cancel creation accepts the amount boundary %i", async (amount) => {
    const p = scenario({ empty: true }); await p.service.propose({ ...command(), refundAmountVnd: amount });
    expect(p.row()).toMatchObject({ orderId, refundAmountVnd: amount, orderStateAtCreation: "in_progress", remainingReviewMs: null });
    expect(p.kit.encrypt).toHaveBeenCalledWith("commission_proposals", p.row().id, "note", "Synthetic note");
    expect(p.events).toEqual([{ eventType: "resolution.proposal_made.v1", payload: { proposalId: p.row().id, orderId, kind: "cancel_with_refund" } }]);
  });
  test.each([0, 500_000, 500_001])("complete creation refuses amount boundary %i", async (amount) => {
    const p = scenario({ empty: true, delivered: true });
    await expect(p.service.propose({ ...command(), kind: "complete_with_refund", refundAmountVnd: amount })).rejects.toMatchObject({ code: "invalid_request" });
    expect(p.events).toHaveLength(0);
  });
  test("a pending proposal is refused before creation", async () => {
    const p = scenario(); await expect(p.service.propose(command())).rejects.toMatchObject({ code: "proposal_pending" }); expect(p.events).toHaveLength(0);
  });
  test("a fourth proposal is refused before creation", async () => {
    const p = scenario({ empty: true, count: 3 }); await expect(p.service.propose(command())).rejects.toMatchObject({ code: "proposal_limit" }); expect(p.events).toHaveLength(0);
  });
  test("the delivered proposal records the remaining review time", async () => {
    const p = scenario({ delivered: true, empty: true }); await p.service.propose(command());
    expect(p.row()).toMatchObject({ orderStateAtCreation: "delivered", remainingReviewMs: 7 * 86_400_000 });
  });
  test("proposal response authorization also rejects an unrelated party on replay", async () => {
    const p = scenario(); await p.service.respondToProposal(p.answer()); const creatorOf = vi.mocked(p.kit.mutate).mock.calls[0]![3];
    vi.mocked(p.orders.lockOrder).mockResolvedValue({ ...p.order, creatorUserId: "synthetic-unrelated" });
    await expect(creatorOf(p.tx)).rejects.toMatchObject({ code: "not_available" });
  });
});
