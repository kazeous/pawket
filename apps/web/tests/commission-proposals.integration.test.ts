import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createCommissionFileService } from "@pawket/commission-files";
import { CommissionError, createCommissionFileAccessPort, createCommissionResolutionOrderPort } from "@pawket/orders";
import { createCommissionRefundPort } from "@pawket/payments";
import { RESOLUTION_POLICY, type ResolutionOrderPort, type ResolutionRefundPort } from "@pawket/resolutions";
import { createTrustCasePort } from "@pawket/trust";
import { createCommissionResolutionTestFixture, resolutions, submit } from "./commission-resolution-test-support.js";
import { commandIds, schema } from "../../../packages/payments/tests/sepay-integration-fixture.js";

const f = createCommissionResolutionTestFixture("i8proposals");
beforeAll(f.initialize, 60_000); afterAll(f.dispose, 30_000);
const HOUR = 3_600_000; const DAY = 24 * HOUR;
type Paid = Awaited<ReturnType<typeof f.paidOrder>>;
const order = (p: Paid) => f.db.select().from(schema.commissionOrders).where(eq(schema.commissionOrders.id, p.orderId)).then((rows) => rows[0]!);
const proposals = (p: Paid) => f.db.select().from(schema.commissionProposals).where(eq(schema.commissionProposals.orderId, p.orderId));
const obligations = (p: Paid) => f.db.select().from(schema.commissionRefundObligations).where(eq(schema.commissionRefundObligations.orderId, p.orderId));
const outbox = (p: Paid) => f.db.select().from(schema.systemOutbox).where(eq(schema.systemOutbox.aggregateType, "commission_proposal"))
  .then((rows) => rows.filter((row) => row.payload.orderId === p.orderId));
const orders = (): ResolutionOrderPort => createCommissionResolutionOrderPort({ applicationRevision: "synthetic-i8", newId: randomUUID });
async function proposalCommand(p: Paid, actor = p.buyer, kind: "cancel_with_refund" | "complete_with_refund" = "cancel_with_refund", amount = 250_000) {
  return { actor, orderId: p.orderId, expectedVersion: (await order(p)).version, kind, refundAmountVnd: amount,
    note: "Synthetic proposal note", ...commandIds() };
}
const response = (p: Paid, proposalId: string, answer: "accept" | "decline" = "accept", actor = p.creator) =>
  ({ actor, proposalId, response: answer, ...commandIds() });
const withdraw = (p: Paid, proposalId: string) => ({ actor: p.buyer, proposalId, ...commandIds() });

describe("commission cancellation proposals", () => {
  test.each(["buyer", "creator"] as const)("either party proposes (%s); the other accepts cancellation atomically", async (role) => {
    const p = await f.paidOrder(); const instance = resolutions(p); const before = await order(p);
    const intentBefore = await f.db.select().from(schema.paymentIntents).where(eq(schema.paymentIntents.id, p.confirmationCommand.paymentIntentId));
    const confirmationsBefore = await f.db.select().from(schema.paymentConfirmations).where(eq(schema.paymentConfirmations.paymentIntentId, p.confirmationCommand.paymentIntentId));
    const command = await proposalCommand(p, p[role]); const made = await instance.propose(command);
    const answer = response(p, made.proposalId, "accept", role === "buyer" ? p.creator : p.buyer);
    const result = await instance.respondToProposal(answer);
    expect(result).toEqual({ proposalId: made.proposalId, orderVersion: before.version + 1 });
    expect(await instance.respondToProposal(answer)).toEqual(result);
    expect(await order(p)).toMatchObject({ state: "closed", closeReason: "cancelled_by_agreement", version: result.orderVersion });
    const slots = await f.db.select().from(schema.commissionReservations).where(eq(schema.commissionReservations.orderId, p.orderId));
    expect(slots).toMatchObject([{ state: "cancelled", releasedAt: p.s.creator.now() }]);
    expect(await obligations(p)).toMatchObject([{ source: "agreement", sourceId: made.proposalId, amountVnd: 250_000,
      paymentIntentId: p.confirmationCommand.paymentIntentId, state: "awaiting_destination" }]);
    expect(await f.db.select().from(schema.paymentIntents).where(eq(schema.paymentIntents.id, p.confirmationCommand.paymentIntentId))).toEqual(intentBefore);
    expect(await f.db.select().from(schema.paymentConfirmations).where(eq(schema.paymentConfirmations.paymentIntentId, p.confirmationCommand.paymentIntentId))).toEqual(confirmationsBefore);
    expect(await proposals(p)).toMatchObject([{ state: "accepted", endedByUserId: answer.actor.userId, version: 2 }]);
    const events = await outbox(p);
    expect(events.map((event) => event.eventType).sort()).toEqual(["resolution.proposal_ended.v1", "resolution.proposal_made.v1"]);
    expect(events.find((event) => event.eventType === "resolution.proposal_made.v1")?.payload).toEqual({ proposalId: made.proposalId, orderId: p.orderId, kind: "cancel_with_refund" });
    expect(events.find((event) => event.eventType === "resolution.proposal_ended.v1")?.payload).toEqual({ proposalId: made.proposalId, orderId: p.orderId, state: "accepted" });
    expect(JSON.stringify(events).includes(command.note)).toBe(false);
    const [row] = await proposals(p);
    expect(JSON.stringify(row).includes(command.note)).toBe(false);
  });
  test.each([0, 500_000])("cancel amount %i is accepted; zero creates no obligation", async (amount) => {
    const p = await f.paidOrder(); const instance = resolutions(p);
    const made = await instance.propose(await proposalCommand(p, p.buyer, "cancel_with_refund", amount));
    await instance.respondToProposal(response(p, made.proposalId));
    expect(await obligations(p)).toHaveLength(amount === 0 ? 0 : 1);
  });
  test("complete_with_refund completes by agreement and the buyer keeps final-file download access", async () => {
    const p = await f.deliveredOrder(); const instance = resolutions(p);
    const made = await instance.propose(await proposalCommand(p, p.creator, "complete_with_refund", 1));
    await instance.respondToProposal(response(p, made.proposalId, "accept", p.buyer));
    expect(await order(p)).toMatchObject({ state: "completed", completionKind: "agreement" });
    expect(await obligations(p)).toMatchObject([{ source: "agreement", sourceId: made.proposalId, amountVnd: 1 }]);
    const [attachment] = await f.db.select().from(schema.commissionFileAttachments).where(and(eq(schema.commissionFileAttachments.targetKind, "submission"), eq(schema.commissionFileAttachments.targetId, p.finalId)));
    const presignDownload = vi.fn(async () => ({ url: "https://example.invalid/synthetic-download", expiresAt: new Date(p.s.creator.now().getTime() + 300_000) }));
    const files = createCommissionFileService({ ...p.s.creator.common, mode: "enabled", fulfillmentMode: "enabled", sessions: p.s.input.identity,
      orders: createCommissionFileAccessPort({ catalog: p.s.catalog }), storage: { presignUpload: vi.fn(), presignDownload } });
    const granted = await files.downloadGrant({ actor: p.buyer, orderId: p.orderId, fileId: attachment!.fileId, disposition: "attachment" });
    expect(!!granted.url).toBe(true); expect(presignDownload).toHaveBeenCalledOnce();
  });
  test.each([0, 500_000, 500_001, 1.5])("complete amount %i is refused", async (amount) => {
    const p = await f.deliveredOrder();
    await expect(resolutions(p).propose(await proposalCommand(p, p.buyer, "complete_with_refund", amount))).rejects.toMatchObject({ code: "invalid_request" });
    expect(await proposals(p)).toHaveLength(0);
  });
  test.each([-1, 500_001, 1.5])("cancel amount %i is refused", async (amount) => {
    const p = await f.paidOrder();
    await expect(resolutions(p).propose(await proposalCommand(p, p.buyer, "cancel_with_refund", amount))).rejects.toMatchObject({ code: "invalid_request" });
  });
  test("completion proposals require a delivered order", async () => {
    const p = await f.paidOrder();
    await expect(resolutions(p).propose(await proposalCommand(p, p.buyer, "complete_with_refund", 1))).rejects.toMatchObject({ code: "invalid_transition" });
  });
  test("the proposer cannot answer their own proposal; the other party cannot withdraw it", async () => {
    const p = await f.paidOrder(); const instance = resolutions(p); const made = await instance.propose(await proposalCommand(p));
    for (const answer of ["accept", "decline"] as const) await expect(instance.respondToProposal(response(p, made.proposalId, answer, p.buyer)))
      .rejects.toMatchObject({ code: "not_available" });
    await expect(instance.withdrawProposal({ ...withdraw(p, made.proposalId), actor: p.creator })).rejects.toMatchObject({ code: "not_available" });
    expect((await proposals(p))[0]?.state).toBe("pending");
  });
  test("a second pending proposal fails proposal_pending", async () => {
    const p = await f.paidOrder(); const instance = resolutions(p); await instance.propose(await proposalCommand(p));
    await expect(instance.propose(await proposalCommand(p, p.creator))).rejects.toMatchObject({ code: "proposal_pending" });
  });
  test("a fourth proposal by one party fails proposal_limit; the other party retains its own allowance", async () => {
    const p = await f.paidOrder(); const instance = resolutions(p);
    for (let i = 0; i < 3; i++) { const made = await instance.propose(await proposalCommand(p)); await instance.withdrawProposal(withdraw(p, made.proposalId)); }
    await expect(instance.propose(await proposalCommand(p))).rejects.toMatchObject({ code: "proposal_limit" });
    await expect(instance.propose(await proposalCommand(p, p.creator))).resolves.toMatchObject({ proposalId: expect.any(String) });
  });
  test.each(["decline", "withdraw"] as const)("%s restores the 48-hour floor with ten hours left", async (ending) => {
    const p = await f.deliveredOrder(); const instance = resolutions(p); const before = await order(p);
    p.s.creator.setNow(new Date(before.reviewEndsAt!.getTime() - 10 * HOUR));
    const made = await instance.propose(await proposalCommand(p)); p.s.creator.advance(2 * HOUR); const endedAt = p.s.creator.now();
    if (ending === "decline") await instance.respondToProposal(response(p, made.proposalId, "decline")); else await instance.withdrawProposal(withdraw(p, made.proposalId));
    expect(await order(p)).toMatchObject({ state: "delivered", completionFloorAt: new Date(endedAt.getTime() + 48 * HOUR), version: before.version + 1 });
    expect(await proposals(p)).toMatchObject([{ remainingReviewMs: 10 * HOUR, state: ending === "decline" ? "declined" : "withdrawn" }]);
    const events = await f.db.select().from(schema.commissionEvents).where(and(eq(schema.commissionEvents.orderId, p.orderId), eq(schema.commissionEvents.reason, "review_time_restored")));
    expect(events).toMatchObject([{ type: "delivered", orderVersion: before.version + 1 }]);
  });
  test.each(["decline", "withdraw"] as const)("%s restores five days recorded remaining after one day", async (ending) => {
    const p = await f.deliveredOrder(); const instance = resolutions(p); const before = await order(p);
    p.s.creator.setNow(new Date(before.reviewEndsAt!.getTime() - 5 * DAY));
    const made = await instance.propose(await proposalCommand(p)); p.s.creator.advance(DAY); const endedAt = p.s.creator.now();
    if (ending === "decline") await instance.respondToProposal(response(p, made.proposalId, "decline")); else await instance.withdrawProposal(withdraw(p, made.proposalId));
    expect((await order(p)).completionFloorAt).toEqual(new Date(endedAt.getTime() + 5 * DAY));
  });
  test("P3: accepting after a new final fails proposal_stale and commits one lapsed proposal", async () => {
    const p = await f.paidOrder(); const instance = resolutions(p); const made = await instance.propose(await proposalCommand(p));
    await submit(p, "final"); const before = await order(p); const answer = response(p, made.proposalId);
    await expect(instance.respondToProposal(answer)).rejects.toMatchObject({ code: "proposal_stale" });
    await expect(instance.respondToProposal(answer)).rejects.toMatchObject({ code: "proposal_stale" });
    expect(await proposals(p)).toMatchObject([{ state: "lapsed", version: 2 }]);
    expect(await order(p)).toEqual(before); expect(await obligations(p)).toHaveLength(0);
    expect((await outbox(p)).filter((event) => event.eventType === "resolution.proposal_ended.v1")).toHaveLength(1);
  });
  test.each([0, 1])("acceptance at respond_by + %i ms fails deadline_passed", async (offset) => {
    const p = await f.paidOrder(); const instance = resolutions(p); const made = await instance.propose(await proposalCommand(p));
    p.s.creator.advance(RESOLUTION_POLICY.proposalResponseMs + offset);
    await expect(instance.respondToProposal(response(p, made.proposalId))).rejects.toMatchObject({ code: "deadline_passed" });
    expect((await order(p)).state).toBe("in_progress"); expect(await obligations(p)).toHaveLength(0);
  });
  test("two parties proposing at the same instant leave one pending proposal and fail the other proposal_pending", async () => {
    const p = await f.paidOrder(); const instance = resolutions(p);
    const commands = [await proposalCommand(p), await proposalCommand(p, p.creator)];
    const results = await Promise.allSettled(commands.map((command) => instance.propose(command)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([{ reason: { code: "proposal_pending" } }]);
    expect(await proposals(p)).toHaveLength(1);
  });
  test("mode disabled refuses every party command", async () => {
    const p = await f.paidOrder(); const made = await resolutions(p).propose(await proposalCommand(p)); const instance = resolutions(p, { mode: "disabled" });
    await expect(instance.propose(await proposalCommand(p, p.creator))).rejects.toMatchObject({ code: "resolution_disabled" });
    await expect(instance.respondToProposal(response(p, made.proposalId))).rejects.toMatchObject({ code: "resolution_disabled" });
    await expect(instance.withdrawProposal(withdraw(p, made.proposalId))).rejects.toMatchObject({ code: "resolution_disabled" });
  });
  test.each(["expired", "version_conflict", "invalid_transition"] as const)("Orders %s maps explicitly at the command boundary", async (code) => {
    const p = await f.paidOrder(); const port = orders(); const instance = resolutions(p, { orders: { ...port, closePaidOrder: async () => { throw new CommissionError(code); } } });
    const made = await instance.propose(await proposalCommand(p));
    await expect(instance.respondToProposal(response(p, made.proposalId))).rejects.toMatchObject({ code: code === "expired" ? "deadline_passed" : code });
    expect((await proposals(p))[0]?.state).toBe("pending"); expect((await order(p)).state).toBe("in_progress");
  });
  test("Postgres 23505 on the pending index maps proposal_pending; other unique violations fail closed", async () => {
    const p = await f.paidOrder(); const port = orders();
    for (const constraint_name of ["commission_proposals_pending_uidx", "unrelated_uidx"]) {
      const cause = Object.assign(new Error("Synthetic constraint failure"), { code: "23505", constraint_name });
      const instance = resolutions(p, { orders: { ...port, lockOrder: async () => { throw new Error("Synthetic database failure", { cause }); } } });
      await expect(instance.propose(await proposalCommand(p))).rejects.toMatchObject({ code: constraint_name === "commission_proposals_pending_uidx" ? "proposal_pending" : "dependency_unavailable" });
    }
  });
  test("proposal creation replays exactly once and binds the order target and payload", async () => {
    const p = await f.paidOrder(); const instance = resolutions(p); const command = await proposalCommand(p);
    const made = await instance.propose(command); expect(await instance.propose(command)).toEqual(made);
    const otherId = await p.s.service.request(p.s.request());
    await expect(instance.propose({ ...command, orderId: otherId })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(instance.propose({ ...command, refundAmountVnd: 1 })).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await proposals(p)).toHaveLength(1);
    p.s.users.delete(p.buyer.userId);
    await expect(instance.propose(command)).rejects.toMatchObject({ code: "not_authorized" });
  });
  test.each(["respond", "withdraw"] as const)("%s replay binds the proposal target, returns the recorded version and checks the session", async (action) => {
    const p = await f.deliveredOrder(); const instance = resolutions(p); const made = await instance.propose(await proposalCommand(p));
    const command = action === "respond" ? response(p, made.proposalId, "decline") : withdraw(p, made.proposalId);
    const run = (proposalId = made.proposalId) => action === "respond"
      ? instance.respondToProposal({ ...command, proposalId, response: "decline" }) : instance.withdrawProposal({ ...command, proposalId });
    p.s.creator.advance(HOUR); const result = await run();
    const next = await instance.propose(await proposalCommand(p));
    await expect(run(next.proposalId)).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await run()).toEqual(result);
    p.s.users.delete(command.actor.userId);
    await expect(run()).rejects.toMatchObject({ code: "not_authorized" });
  });
  test("unrelated sessions and revoked sessions cannot mutate the target", async () => {
    const p = await f.paidOrder(); const instance = resolutions(p); const unrelated = await p.s.buyer();
    await expect(instance.propose(await proposalCommand(p, unrelated))).rejects.toMatchObject({ code: "not_available" });
    const made = await instance.propose(await proposalCommand(p));
    await expect(instance.respondToProposal(response(p, made.proposalId, "accept", unrelated))).rejects.toMatchObject({ code: "not_available" });
    await expect(instance.withdrawProposal({ ...withdraw(p, made.proposalId), actor: unrelated })).rejects.toMatchObject({ code: "not_available" });
    p.s.users.delete(p.creator.userId);
    await expect(instance.respondToProposal(response(p, made.proposalId))).rejects.toMatchObject({ code: "not_authorized" });
  });
  test("acceptance settles an open dispute and its case in the same transaction", async () => {
    const p = await f.paidOrder(); const at = p.s.creator.now(); const disputeId = randomUUID(); const cases = createTrustCasePort();
    const opened = await f.db.transaction(async (tx) => {
      await tx.insert(schema.commissionDisputes).values({ id: disputeId, orderId: p.orderId, openerUserId: p.buyer.userId, openerRole: "buyer", trigger: "overdue",
        triggerAt: at, reason: "not_delivered", requestedOutcome: "close", requestedRefundVnd: 500_000, orderStateAtOpen: "in_progress",
        respondBy: new Date(at.getTime() + 5 * DAY), openedAt: at });
      return cases.openCase(tx, { kind: "dispute", orderId: p.orderId, sourceType: "commission_dispute", sourceId: disputeId,
        policyRevisionId: p.s.policyId, requestId: randomUUID(), at });
    });
    const instance = resolutions(p); const made = await instance.propose(await proposalCommand(p));
    await instance.respondToProposal(response(p, made.proposalId));
    expect(await f.db.select().from(schema.commissionDisputes).where(eq(schema.commissionDisputes.id, disputeId))).toMatchObject([{ state: "settled", closedAt: at, version: 2 }]);
    expect(await f.db.select().from(schema.trustCases).where(eq(schema.trustCases.id, opened.caseId))).toMatchObject([{ state: "resolved", resolutionKind: "settled" }]);
  });
  test("a refund-port failure rolls back the order, proposal, reservation and outbox", async () => {
    const p = await f.paidOrder(); const refunds: ResolutionRefundPort = createCommissionRefundPort({ keyring: p.s.input.keyring, calendarVersion: "vn-proposals-test" });
    const instance = resolutions(p, { refunds: { ...refunds, createObligation: async () => { throw new Error("Synthetic dependency failure"); } } });
    const made = await instance.propose(await proposalCommand(p)); const before = await order(p);
    await expect(instance.respondToProposal(response(p, made.proposalId))).rejects.toMatchObject({ code: "dependency_unavailable" });
    expect(await order(p)).toEqual(before); expect((await proposals(p))[0]?.state).toBe("pending");
    expect(await obligations(p)).toHaveLength(0); expect(await outbox(p)).toHaveLength(1);
    expect(await f.db.select().from(schema.commissionReservations).where(eq(schema.commissionReservations.orderId, p.orderId))).toMatchObject([{ state: "occupied" }]);
  });
  test("commit-time deadline passage rolls back acceptance", async () => {
    const p = await f.paidOrder(); const port = orders();
    const instance = resolutions(p, { orders: { ...port, closePaidOrder: async (tx, command) => {
      const result = await port.closePaidOrder(tx, command); p.s.creator.advance(1); return result;
    } } });
    const made = await instance.propose(await proposalCommand(p)); p.s.creator.advance(RESOLUTION_POLICY.proposalResponseMs - 1);
    await expect(instance.respondToProposal(response(p, made.proposalId))).rejects.toMatchObject({ code: "deadline_passed" });
    expect((await order(p)).state).toBe("in_progress"); expect((await proposals(p))[0]?.state).toBe("pending"); expect(await obligations(p)).toHaveLength(0);
  });
});
