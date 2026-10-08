import { randomUUID } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import { commissionDisputes, commissionProposals, insertOutboxEvent, type PawketTransaction } from "@pawket/database";
import { commissionIdentifier, commissionUuid, readCommissionRecord, type CommissionResolutionOrderFacts } from "@pawket/orders";
import { PROPOSAL_KINDS, resolutionFail, type ProposalKind, type ResolutionActor, type ResolutionCommand } from "./contracts.js";
import type { createResolutionCommandKit } from "./command-kit.js";
import { effectiveResolutionDeadline } from "./deadlines.js";
import { normalizeResolutionText, RESOLUTION_POLICY } from "./policy.js";
import type { ResolutionOrderPort, ResolutionRefundPort, ResolutionPaymentFactsPort, ResolutionCasePort } from "./ports.js";

export type CommissionProposal = typeof commissionProposals.$inferSelect;
type Kit = ReturnType<typeof createResolutionCommandKit>;
type Input = Readonly<{ orders: ResolutionOrderPort; refunds: ResolutionRefundPort; payments: ResolutionPaymentFactsPort;
  cases: ResolutionCasePort; mode: "disabled" | "enabled" }>;
type Propose = ResolutionCommand & Readonly<{ orderId: string; expectedVersion: number; kind: ProposalKind; refundAmountVnd: number; note: string }>;
type Target = ResolutionCommand & Readonly<{ proposalId: string }>;
type Answer = Target & Readonly<{ response: "accept" | "decline" }>;
type EndState = "declined" | "withdrawn" | "expired" | "lapsed";
type Result = Readonly<{ proposalId: string; orderVersion: number }>;
const commandKeys = ["actor", "idempotencyKey", "requestId"];
function exact(command: unknown, keys: readonly string[]) {
  if (!readCommissionRecord(command, [...commandKeys, ...keys])) resolutionFail("invalid_request");
}
const versionValid = (value: number) => Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_646;
function decode(reference: string): { proposalId: string; orderVersion?: number; error?: "proposal_stale" } {
  const parts = reference.split(":"); const proposalId = parts[0];
  if (!commissionUuid(proposalId) || parts.length > 3) resolutionFail("dependency_unavailable");
  if (parts.length === 1) return { proposalId };
  const orderVersion = Number(parts[1]);
  if (!Number.isSafeInteger(orderVersion) || orderVersion < 1 || orderVersion > 2_147_483_647 || String(orderVersion) !== parts[1]
    || (parts.length === 3 && parts[2] !== "proposal_stale")) resolutionFail("dependency_unavailable");
  return { proposalId, orderVersion, ...(parts.length === 3 ? { error: "proposal_stale" as const } : {}) };
}
// Idempotency references accept identifiers only; persist the outcome without JSON or private content.
const reference = (result: Result, error?: "proposal_stale") => `${result.proposalId}:${result.orderVersion}${error ? `:${error}` : ""}`;

export function isProposalStale(proposal: Readonly<Pick<CommissionProposal, "orderStateAtCreation" | "createdAt">>, facts: CommissionResolutionOrderFacts): boolean {
  return facts.state !== proposal.orderStateAtCreation || (facts.lastFulfillmentMoveAt !== null && facts.lastFulfillmentMoveAt > proposal.createdAt);
}

export function createProposalService(kit: Kit, input: Input) {
  if (input.mode !== "enabled" && input.mode !== "disabled") resolutionFail("invalid_request");
  const enabled = () => { if (input.mode !== "enabled") resolutionFail("resolution_disabled"); };
  async function owned(tx: PawketTransaction, orderId: string, actor: ResolutionActor): Promise<CommissionResolutionOrderFacts> {
    const order = await input.orders.lockOrder(tx, orderId);
    if (!order || (order.buyerUserId !== actor.userId && order.creatorUserId !== actor.userId)) resolutionFail("not_available");
    return order;
  }
  async function proposal(tx: PawketTransaction, proposalId: string, locked = false): Promise<CommissionProposal> {
    const query = tx.select().from(commissionProposals).where(eq(commissionProposals.id, proposalId)).limit(1);
    const [row] = await (locked ? query.for("update") : query);
    if (!row) resolutionFail("not_available"); return row;
  }
  async function creatorOf(tx: PawketTransaction, command: Target, role: "proposer" | "other"): Promise<string> {
    const row = await proposal(tx, command.proposalId);
    const order = await owned(tx, row.orderId, command.actor);
    if ((row.proposerUserId === command.actor.userId) !== (role === "proposer")) resolutionFail("not_available");
    return order.creatorUserId;
  }
  async function recordEnd(tx: PawketTransaction, row: CommissionProposal, state: EndState | "accepted", at: Date, actor: ResolutionActor | null) {
    const [ended] = await tx.update(commissionProposals).set({ state, endedAt: at, endedByUserId: actor?.userId ?? null, version: row.version + 1 })
      .where(and(eq(commissionProposals.id, row.id), eq(commissionProposals.version, row.version), eq(commissionProposals.state, "pending"))).returning();
    if (!ended) resolutionFail("version_conflict");
    await insertOutboxEvent(tx, { eventType: "resolution.proposal_ended.v1", eventVersion: 1, aggregateType: "commission_proposal", aggregateId: row.id,
      payload: { proposalId: row.id, orderId: row.orderId, state }, occurredAt: at });
  }
  /** Internal transaction helper. Party commands and maintenance share the creator/order fence and restoration rule. */
  async function endProposalWithoutAgreement(tx: PawketTransaction, candidate: CommissionProposal, state: EndState, at: Date,
    actor: ResolutionActor | null, requestId: string): Promise<Result> {
    if (!["declined", "withdrawn", "expired", "lapsed"].includes(state) || !(at instanceof Date) || !Number.isFinite(at.getTime())
      || !commissionIdentifier(requestId) || (actor !== null && (!readCommissionRecord(actor, ["userId", "sessionId"])
        || !commissionIdentifier(actor.userId) || !commissionIdentifier(actor.sessionId)))) resolutionFail("invalid_request");
    const order = await input.orders.lockOrder(tx, candidate.orderId);
    if (!order) resolutionFail("not_available");
    const row = await proposal(tx, candidate.id, true);
    if (row.orderId !== order.id) resolutionFail("not_available");
    if (row.state !== "pending") return { proposalId: row.id, orderVersion: order.version };
    if (at < row.createdAt) resolutionFail("invalid_request");
    await recordEnd(tx, row, state, at, actor);
    let orderVersion = order.version;
    if (order.state === "delivered" && !isProposalStale(row, order)) {
      const floorAt = new Date(at.getTime() + Math.max(row.remainingReviewMs ?? 0, RESOLUTION_POLICY.restoreFloorMs));
      const restored = await input.orders.restoreReviewTime(tx, { orderId: order.id, expectedVersion: order.version, floorAt, actor, requestId, at });
      orderVersion = restored.version;
    }
    return { proposalId: row.id, orderVersion };
  }
  async function deadline(tx: PawketTransaction, row: CommissionProposal, at: Date): Promise<Date> {
    const until = await effectiveResolutionDeadline(tx, row.respondBy);
    if (!until) resolutionFail("resolution_disabled");
    if (at < row.createdAt) resolutionFail("invalid_request");
    if (at >= until) resolutionFail("deadline_passed"); return until;
  }
  async function settleDispute(tx: PawketTransaction, orderId: string, actor: ResolutionActor, requestId: string, at: Date) {
    const [row] = await tx.select().from(commissionDisputes).where(and(eq(commissionDisputes.orderId, orderId), eq(commissionDisputes.state, "open"))).limit(1).for("update");
    if (!row) return;
    const [settled] = await tx.update(commissionDisputes).set({ state: "settled", closedAt: at, version: row.version + 1 })
      .where(and(eq(commissionDisputes.id, row.id), eq(commissionDisputes.version, row.version), eq(commissionDisputes.state, "open"))).returning();
    if (!settled) resolutionFail("version_conflict");
    const openCase = await input.cases.findOpenCase(tx, { kind: "dispute", sourceId: row.id });
    if (!openCase) resolutionFail("dependency_unavailable");
    await input.cases.resolveCase(tx, { caseId: openCase.caseId, resolutionKind: "settled", actor, reason: null, requestId, at });
  }
  function result(reference: string): Result {
    const recorded = decode(reference);
    // The lapsed state and idempotency result must commit before the caller observes this rejection.
    if (recorded.error) resolutionFail(recorded.error);
    if (recorded.orderVersion === undefined) resolutionFail("dependency_unavailable");
    return { proposalId: recorded.proposalId, orderVersion: recorded.orderVersion };
  }
  return {
    async propose(command: Propose): Promise<{ proposalId: string }> {
      enabled(); exact(command, ["orderId", "expectedVersion", "kind", "refundAmountVnd", "note"]);
      if (!commissionUuid(command.orderId) || !versionValid(command.expectedVersion) || !(PROPOSAL_KINDS as readonly unknown[]).includes(command.kind)
        || !Number.isSafeInteger(command.refundAmountVnd) || command.refundAmountVnd < 0 || command.refundAmountVnd > 50_000_000) resolutionFail("invalid_request");
      const note = normalizeResolutionText(command.note, 1, RESOLUTION_POLICY.noteMaxCodePoints);
      const reference = await kit.mutate(command, "propose", [command.orderId, command.expectedVersion, command.kind, command.refundAmountVnd, note],
        async (tx) => (await owned(tx, command.orderId, command.actor)).creatorUserId, async (tx) => {
          const order = await owned(tx, command.orderId, command.actor); const at = kit.now();
          if (order.version !== command.expectedVersion) resolutionFail("version_conflict");
          if (order.state !== "in_progress" && order.state !== "delivered") resolutionFail("invalid_transition");
          if (command.kind === "complete_with_refund" && order.state !== "delivered") resolutionFail("invalid_transition");
          const paid = await input.payments.paidIntent(tx, order.id);
          if (!paid || paid.amountVnd !== order.amountVnd) resolutionFail("dependency_unavailable");
          if (command.refundAmountVnd > paid.amountVnd || (command.kind === "complete_with_refund"
            && (command.refundAmountVnd < 1 || command.refundAmountVnd >= paid.amountVnd))) resolutionFail("invalid_request");
          const [pending] = await tx.select({ id: commissionProposals.id }).from(commissionProposals)
            .where(and(eq(commissionProposals.orderId, order.id), eq(commissionProposals.state, "pending"))).limit(1);
          if (pending) resolutionFail("proposal_pending");
          const [total] = await tx.select({ count: count() }).from(commissionProposals)
            .where(and(eq(commissionProposals.orderId, order.id), eq(commissionProposals.proposerUserId, command.actor.userId)));
          if (!total) resolutionFail("dependency_unavailable");
          if (total.count >= RESOLUTION_POLICY.maxProposalsPerParty) resolutionFail("proposal_limit");
          let remainingReviewMs: number | null = null;
          if (order.state === "delivered") {
            const dueAt = await input.orders.completionDueAt(tx, order.id);
            if (!dueAt) resolutionFail("resolution_disabled");
            if (at >= dueAt) resolutionFail("deadline_passed");
            remainingReviewMs = dueAt.getTime() - at.getTime();
          }
          const proposalId = randomUUID();
          await tx.insert(commissionProposals).values({ id: proposalId, orderId: order.id, proposerUserId: command.actor.userId,
            proposerRole: order.buyerUserId === command.actor.userId ? "buyer" : "creator", kind: command.kind, refundAmountVnd: command.refundAmountVnd,
            noteEnvelope: kit.encrypt("commission_proposals", proposalId, "note", note), orderStateAtCreation: order.state, remainingReviewMs,
            respondBy: new Date(at.getTime() + RESOLUTION_POLICY.proposalResponseMs), createdAt: at, actorSessionId: command.actor.sessionId, requestId: command.requestId });
          await insertOutboxEvent(tx, { eventType: "resolution.proposal_made.v1", eventVersion: 1, aggregateType: "commission_proposal", aggregateId: proposalId,
            payload: { proposalId, orderId: order.id, kind: command.kind }, occurredAt: at });
          return { resultReference: proposalId, at };
        });
      return { proposalId: decode(reference).proposalId };
    },
    async respondToProposal(command: Answer): Promise<Result> {
      enabled(); exact(command, ["proposalId", "response"]);
      if (!commissionUuid(command.proposalId) || (command.response !== "accept" && command.response !== "decline")) resolutionFail("invalid_request");
      return result(await kit.mutate(command, "respond_to_proposal", [command.proposalId, command.response],
        (tx) => creatorOf(tx, command, "other"), async (tx) => {
          const row = await proposal(tx, command.proposalId, true); const order = await owned(tx, row.orderId, command.actor); const at = kit.now();
          if (row.state !== "pending") resolutionFail("invalid_transition");
          const guardUntil = await deadline(tx, row, at);
          if (command.response === "decline") {
            const ended = await endProposalWithoutAgreement(tx, row, "declined", at, command.actor, command.requestId);
            return { resultReference: reference(ended), at, guardUntil };
          }
          if (isProposalStale(row, order)) {
            const ended = await endProposalWithoutAgreement(tx, row, "lapsed", at, command.actor, command.requestId);
            return { resultReference: reference(ended, "proposal_stale"), at, guardUntil };
          }
          const change = { orderId: order.id, expectedVersion: order.version, actor: command.actor, requestId: command.requestId, at };
          const changed = row.kind === "cancel_with_refund"
            ? await input.orders.closePaidOrder(tx, { ...change, reason: "cancelled_by_agreement" })
            : await input.orders.completeByResolution(tx, { ...change, kind: "agreement" });
          if (row.refundAmountVnd > 0) {
            const paid = await input.payments.paidIntent(tx, order.id);
            if (!paid || paid.amountVnd !== order.amountVnd) resolutionFail("dependency_unavailable");
            await input.refunds.createObligation(tx, { orderId: order.id, paymentIntentId: paid.paymentIntentId, creatorUserId: order.creatorUserId,
              buyerUserId: order.buyerUserId, source: "agreement", sourceId: row.id, amountVnd: row.refundAmountVnd, requestId: command.requestId, at });
          }
          await settleDispute(tx, order.id, command.actor, command.requestId, at);
          await recordEnd(tx, row, "accepted", at, command.actor);
          return { resultReference: reference({ proposalId: row.id, orderVersion: changed.version }), at, guardUntil };
        }));
    },
    async withdrawProposal(command: Target): Promise<Result> {
      enabled(); exact(command, ["proposalId"]);
      if (!commissionUuid(command.proposalId)) resolutionFail("invalid_request");
      return result(await kit.mutate(command, "withdraw_proposal", [command.proposalId], (tx) => creatorOf(tx, command, "proposer"), async (tx) => {
        const row = await proposal(tx, command.proposalId, true); const at = kit.now();
        if (row.state !== "pending") resolutionFail("invalid_transition");
        const guardUntil = await deadline(tx, row, at);
        const ended = await endProposalWithoutAgreement(tx, row, "withdrawn", at, command.actor, command.requestId);
        return { resultReference: reference(ended), at, guardUntil };
      }));
    },
    endProposalWithoutAgreement,
  };
}
