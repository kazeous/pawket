import { and, eq } from "drizzle-orm";
import { commissionDisputes, commissionProposals, insertOutboxEvent, type PawketTransaction } from "@pawket/database";
import { commissionUuid, readCommissionRecord, type CommissionResolutionOrderFacts } from "@pawket/orders";
import { resolutionFail, type ResolutionActor, type ResolutionCommand } from "./contracts.js";
import type { createResolutionCommandKit } from "./command-kit.js";
import type { ResolutionCasePort, ResolutionOrderPort, ResolutionPaymentFactsPort, ResolutionRefundPort, ResolutionStandingPort } from "./ports.js";

type Kit = ReturnType<typeof createResolutionCommandKit>;
type ExitPorts = Readonly<{ orders: ResolutionOrderPort; refunds: ResolutionRefundPort; payments: ResolutionPaymentFactsPort; cases: ResolutionCasePort }>;
type Input = ExitPorts & Readonly<{ standing: ResolutionStandingPort; mode: "disabled" | "enabled" }>;
type Cancel = ResolutionCommand & Readonly<{ orderId: string; expectedVersion: number }>;
type Exit = Readonly<{ reason: "buyer_cancelled_after_suspension" | "fulfillment_frozen"; actor: ResolutionActor; requestId: string; at: Date }>;

/** Both callers hold the creator fence, a live order and suspended standing in this transaction. */
export async function closeSuspendedPaidOrder(tx: PawketTransaction, input: ExitPorts, facts: CommissionResolutionOrderFacts, command: Exit): Promise<string> {
  const paid = await input.payments.paidIntent(tx, facts.id);
  if (!paid || paid.amountVnd !== facts.amountVnd) resolutionFail("dependency_unavailable");
  await input.orders.closePaidOrder(tx, { orderId: facts.id, expectedVersion: facts.version, ...command });
  const { obligationId } = await input.refunds.createObligation(tx, { orderId: facts.id, paymentIntentId: paid.paymentIntentId,
    creatorUserId: facts.creatorUserId, buyerUserId: facts.buyerUserId, source: command.reason === "fulfillment_frozen" ? "fulfillment_freeze" : "suspension_cancel",
    sourceId: facts.id, amountVnd: paid.amountVnd, requestId: command.requestId, at: command.at });
  // These exits end the order: supersession must never restore review time.
  const proposals = await tx.select().from(commissionProposals)
    .where(and(eq(commissionProposals.orderId, facts.id), eq(commissionProposals.state, "pending"))).for("update");
  for (const proposal of proposals) {
    const [ended] = await tx.update(commissionProposals).set({ state: "superseded", endedAt: command.at, endedByUserId: command.actor.userId, version: proposal.version + 1 })
      .where(and(eq(commissionProposals.id, proposal.id), eq(commissionProposals.version, proposal.version), eq(commissionProposals.state, "pending"))).returning();
    if (!ended) resolutionFail("version_conflict");
    await insertOutboxEvent(tx, { eventType: "resolution.proposal_ended.v1", eventVersion: 1, aggregateType: "commission_proposal", aggregateId: proposal.id,
      payload: { proposalId: proposal.id, orderId: facts.id, state: "superseded" }, occurredAt: command.at });
  }
  const [dispute] = await tx.select().from(commissionDisputes)
    .where(and(eq(commissionDisputes.orderId, facts.id), eq(commissionDisputes.state, "open"))).limit(1).for("update");
  if (dispute) {
    const [ended] = await tx.update(commissionDisputes).set({ state: "superseded", closedAt: command.at, version: dispute.version + 1 })
      .where(and(eq(commissionDisputes.id, dispute.id), eq(commissionDisputes.version, dispute.version), eq(commissionDisputes.state, "open"))).returning();
    if (!ended) resolutionFail("version_conflict");
    const openCase = await input.cases.findOpenCase(tx, { kind: "dispute", sourceId: dispute.id });
    if (!openCase) resolutionFail("dependency_unavailable");
    await input.cases.resolveCase(tx, { caseId: openCase.caseId, resolutionKind: "superseded", actor: command.actor, reason: null,
      requestId: command.requestId, at: command.at });
    await insertOutboxEvent(tx, { eventType: "resolution.dispute_closed.v1", eventVersion: 1, aggregateType: "commission_dispute", aggregateId: dispute.id,
      payload: { disputeId: dispute.id, orderId: facts.id, state: "superseded" }, occurredAt: command.at });
  }
  return obligationId;
}

export function createSuspensionService(kit: Kit, input: Input) {
  if (input.mode !== "enabled" && input.mode !== "disabled") resolutionFail("invalid_request");
  async function buyerOrder(tx: PawketTransaction, command: Cancel) {
    const facts = await input.orders.lockOrder(tx, command.orderId);
    if (!facts || facts.buyerUserId !== command.actor.userId) resolutionFail("not_available"); return facts;
  }
  return {
    async cancelAfterSuspension(command: Cancel): Promise<{ obligationId: string }> {
      if (input.mode !== "enabled") resolutionFail("resolution_disabled");
      if (!readCommissionRecord(command, ["actor", "orderId", "expectedVersion", "idempotencyKey", "requestId"]) || !commissionUuid(command.orderId)
        || !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1 || command.expectedVersion > 2_147_483_646) resolutionFail("invalid_request");
      const reference = await kit.mutate(command, "suspension_cancel", [command.orderId, command.expectedVersion],
        async (tx) => (await buyerOrder(tx, command)).creatorUserId, async (tx) => {
          const facts = await buyerOrder(tx, command); const at = kit.now();
          if (facts.version !== command.expectedVersion) resolutionFail("version_conflict");
          if (!["in_progress", "delivered"].includes(facts.state)) resolutionFail("invalid_transition");
          if (await input.standing.readCreatorStanding(tx, facts.creatorUserId) !== "suspended") resolutionFail("invalid_transition");
          const obligationId = await closeSuspendedPaidOrder(tx, input, facts, { reason: "buyer_cancelled_after_suspension", actor: command.actor, requestId: command.requestId, at });
          return { resultReference: obligationId, at };
        });
      if (!commissionUuid(reference)) resolutionFail("dependency_unavailable"); return { obligationId: reference };
    },
  };
}
export type SuspensionService = ReturnType<typeof createSuspensionService>;
