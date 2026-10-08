import { randomUUID } from "node:crypto";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { commissionDisputes, commissionDisputeStatements, commissionProposals, insertOutboxEvent, type PawketTransaction } from "@pawket/database";
import { commissionUuid, readCommissionRecord, type CommissionResolutionOrderFacts } from "@pawket/orders";
import { DISPUTE_REASONS, RULING_OUTCOMES, resolutionFail, type DisputeReason, type ResolutionActor, type ResolutionCommand, type RulingOutcome } from "./contracts.js";
import type { createResolutionCommandKit } from "./command-kit.js";
import { effectiveResolutionDeadline } from "./deadlines.js";
import { normalizeResolutionText, RESOLUTION_POLICY } from "./policy.js";
import type { ResolutionCasePort, ResolutionOrderPort, ResolutionRefundPort } from "./ports.js";

type Dispute = typeof commissionDisputes.$inferSelect;
type Kit = ReturnType<typeof createResolutionCommandKit>;
type Input = Readonly<{ orders: ResolutionOrderPort; refunds: ResolutionRefundPort; cases: ResolutionCasePort; mode: "disabled" | "enabled" }>;
type Open = ResolutionCommand & Readonly<{ orderId: string; expectedVersion: number; reason: DisputeReason; statement: string;
  requestedOutcome: Readonly<{ kind: RulingOutcome; refundAmountVnd: number }>; acknowledgeStaffReview: true }>;
type Target = ResolutionCommand & Readonly<{ disputeId: string }>;
type Trigger = Readonly<{ kind: "final_delivery" | "overdue" | "proposal_declined"; at: Date; endsAt: Date | null }>;
const commandKeys = ["actor", "idempotencyKey", "requestId"];
function exact(command: unknown, keys: readonly string[]) {
  if (!readCommissionRecord(command, [...commandKeys, ...keys])) resolutionFail("invalid_request");
}

/** Shared by commands and participant views; callers hold the creator/order fence. */
export async function evaluateDisputeTrigger(tx: PawketTransaction, orders: Pick<ResolutionOrderPort, "completionDueAt">,
  order: CommissionResolutionOrderFacts, actor: ResolutionActor, at: Date): Promise<Trigger | null> {
  if (order.state !== "in_progress" && order.state !== "delivered") return null;
  const withdrawn = await tx.select().from(commissionDisputes).where(and(eq(commissionDisputes.orderId, order.id),
    eq(commissionDisputes.openerUserId, actor.userId), eq(commissionDisputes.state, "withdrawn"))).orderBy(desc(commissionDisputes.closedAt));
  // Reopening needs an event newer than the withdrawn dispute's opening. A proposal may end while it is open.
  const consumedAt = withdrawn[0]?.openedAt ?? null;
  const buyer = order.buyerUserId === actor.userId;
  if (buyer && order.state === "delivered" && order.deliveredAt && at >= order.deliveredAt && (!consumedAt || order.deliveredAt > consumedAt)) {
    const due = await orders.completionDueAt(tx, order.id);
    if (due && at < due) return { kind: "final_delivery", at: order.deliveredAt, endsAt: due };
  }
  if (buyer && order.state === "in_progress" && order.dueAt && withdrawn.length === 0) {
    const triggerAt = new Date(order.dueAt.getTime() + RESOLUTION_POLICY.overdueTriggerMs);
    if (at >= triggerAt) return { kind: "overdue", at: triggerAt, endsAt: null };
  }
  const ended = await tx.select().from(commissionProposals).where(and(eq(commissionProposals.orderId, order.id),
    inArray(commissionProposals.state, ["declined", "expired"]), buyer ? undefined : eq(commissionProposals.proposerUserId, actor.userId)))
    .orderBy(desc(commissionProposals.endedAt), desc(commissionProposals.id));
  for (const row of ended) {
    if (!row.endedAt || row.endedAt > at || (consumedAt && row.endedAt <= consumedAt)) continue;
    const endsAt = await effectiveResolutionDeadline(tx, new Date(row.endedAt.getTime() + RESOLUTION_POLICY.proposalTriggerWindowMs));
    if (endsAt && at <= endsAt) return { kind: "proposal_declined", at: row.endedAt, endsAt };
  }
  return null;
}

export function createDisputeService(kit: Kit, input: Input) {
  if (input.mode !== "enabled" && input.mode !== "disabled") resolutionFail("invalid_request");
  const enabled = () => { if (input.mode !== "enabled") resolutionFail("resolution_disabled"); };
  async function owned(tx: PawketTransaction, orderId: string, actor: ResolutionActor): Promise<CommissionResolutionOrderFacts> {
    const order = await input.orders.lockOrder(tx, orderId);
    if (!order || (order.buyerUserId !== actor.userId && order.creatorUserId !== actor.userId)) resolutionFail("not_available");
    return order;
  }
  async function dispute(tx: PawketTransaction, id: string, locked = false): Promise<Dispute> {
    const query = tx.select().from(commissionDisputes).where(eq(commissionDisputes.id, id)).limit(1);
    const [row] = await (locked ? query.for("update") : query);
    if (!row) resolutionFail("not_available"); return row;
  }
  async function creatorOf(tx: PawketTransaction, command: Target, openerOnly = false) {
    const row = await dispute(tx, command.disputeId); const order = await owned(tx, row.orderId, command.actor);
    if (openerOnly && row.openerUserId !== command.actor.userId) resolutionFail("not_available");
    return order.creatorUserId;
  }
  async function add(tx: PawketTransaction, row: Dispute, actor: ResolutionActor, text: string, requestId: string, at: Date, opening = false) {
    const order = await owned(tx, row.orderId, actor);
    if (at < row.openedAt) resolutionFail("invalid_request");
    const authorRole = actor.userId === order.buyerUserId ? "buyer" : "creator";
    const [total] = await tx.select({ count: count() }).from(commissionDisputeStatements)
      .where(and(eq(commissionDisputeStatements.disputeId, row.id), eq(commissionDisputeStatements.authorRole, authorRole)));
    if (!total) resolutionFail("dependency_unavailable");
    if (total.count >= RESOLUTION_POLICY.maxStatementsPerParty) resolutionFail("statement_limit");
    const kind = opening ? "opening" : row.openerUserId !== actor.userId && total.count === 0 ? "response" : "statement";
    const statementId = randomUUID();
    await tx.insert(commissionDisputeStatements).values({ id: statementId, disputeId: row.id, authorUserId: actor.userId, authorRole, kind,
      textEnvelope: kit.encrypt("commission_dispute_statements", statementId, "text", text),
      requestedOutcome: opening ? row.requestedOutcome : null, requestedRefundVnd: opening ? row.requestedRefundVnd : null,
      actorSessionId: actor.sessionId, requestId, createdAt: at });
    if (!opening) await insertOutboxEvent(tx, { eventType: "resolution.dispute_statement_added.v1", eventVersion: 1,
      aggregateType: "commission_dispute", aggregateId: row.id, payload: { disputeId: row.id, statementId, authorRole }, occurredAt: at });
    return statementId;
  }
  function openingResult(reference: string) {
    const parts = reference.split(":");
    if (parts.length !== 2 || !commissionUuid(parts[0]) || !commissionUuid(parts[1])) resolutionFail("dependency_unavailable");
    return { disputeId: parts[0], caseId: parts[1] };
  }
  return {
    async openDispute(command: Open): Promise<{ disputeId: string; caseId: string }> {
      enabled(); exact(command, ["orderId", "expectedVersion", "reason", "statement", "requestedOutcome", "acknowledgeStaffReview"]);
      const outcome = readCommissionRecord(command.requestedOutcome, ["kind", "refundAmountVnd"]);
      if (!commissionUuid(command.orderId) || !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1 || command.expectedVersion > 2_147_483_646
        || !(DISPUTE_REASONS as readonly unknown[]).includes(command.reason) || command.acknowledgeStaffReview !== true || !outcome
        || !(RULING_OUTCOMES as readonly unknown[]).includes(outcome.kind) || !Number.isSafeInteger(outcome.refundAmountVnd)
        || typeof outcome.refundAmountVnd !== "number" || outcome.refundAmountVnd < 0 || outcome.refundAmountVnd > 50_000_000) resolutionFail("invalid_request");
      const text = normalizeResolutionText(command.statement, 1, RESOLUTION_POLICY.statementMaxCodePoints);
      return openingResult(await kit.mutate(command, "open_dispute", [command.orderId, command.expectedVersion, command.reason, text, outcome.kind, outcome.refundAmountVnd, true],
        async (tx) => (await owned(tx, command.orderId, command.actor)).creatorUserId, async (tx) => {
          const order = await owned(tx, command.orderId, command.actor); const at = kit.now();
          // Terminal state takes priority over a stale version in the completion race.
          if (order.state !== "in_progress" && order.state !== "delivered") resolutionFail("invalid_transition");
          if (order.version !== command.expectedVersion) resolutionFail("version_conflict");
          if (order.amountVnd === null || !order.policyRevisionId) resolutionFail("dependency_unavailable");
          if (command.requestedOutcome.refundAmountVnd > order.amountVnd || (command.requestedOutcome.kind === "complete"
            && (order.state !== "delivered" || command.requestedOutcome.refundAmountVnd >= order.amountVnd))) resolutionFail("invalid_request");
          const [open] = await tx.select({ id: commissionDisputes.id }).from(commissionDisputes)
            .where(and(eq(commissionDisputes.orderId, order.id), eq(commissionDisputes.state, "open"))).limit(1);
          if (open) resolutionFail("dispute_open");
          const trigger = await evaluateDisputeTrigger(tx, input.orders, order, command.actor, at);
          if (!trigger) resolutionFail("dispute_not_allowed");
          let remainingReviewMs: number | null = null;
          if (order.state === "delivered") {
            const due = await input.orders.completionDueAt(tx, order.id);
            if (!due) resolutionFail("resolution_disabled");
            remainingReviewMs = Math.max(0, due.getTime() - at.getTime());
          }
          const disputeId = randomUUID();
          const [row] = await tx.insert(commissionDisputes).values({ id: disputeId, orderId: order.id, openerUserId: command.actor.userId,
            openerRole: order.buyerUserId === command.actor.userId ? "buyer" : "creator", trigger: trigger.kind, triggerAt: trigger.at,
            reason: command.reason, requestedOutcome: command.requestedOutcome.kind, requestedRefundVnd: command.requestedOutcome.refundAmountVnd,
            orderStateAtOpen: order.state, remainingReviewMs, openedAt: at, respondBy: new Date(at.getTime() + RESOLUTION_POLICY.disputeResponseMs) }).returning();
          if (!row) resolutionFail("dependency_unavailable");
          await add(tx, row, command.actor, text, command.requestId, at, true);
          const opened = await input.cases.openCase(tx, { kind: "dispute", orderId: order.id, sourceType: "commission_dispute", sourceId: disputeId,
            policyRevisionId: order.policyRevisionId, requestId: command.requestId, at });
          await insertOutboxEvent(tx, { eventType: "resolution.dispute_opened.v1", eventVersion: 1, aggregateType: "commission_dispute", aggregateId: disputeId,
            payload: { disputeId, orderId: order.id }, occurredAt: at });
          // The proposal window includes its final millisecond; the completion window does not.
          const guardUntil = trigger.endsAt ? new Date(trigger.endsAt.getTime() + (trigger.kind === "proposal_declined" ? 1 : 0)) : undefined;
          return { resultReference: `${disputeId}:${opened.caseId}`, at, guardUntil };
        }));
    },
    async addStatement(command: Target & Readonly<{ text: string }>): Promise<{ statementId: string }> {
      enabled(); exact(command, ["disputeId", "text"]); if (!commissionUuid(command.disputeId)) resolutionFail("invalid_request");
      const text = normalizeResolutionText(command.text, 1, RESOLUTION_POLICY.statementMaxCodePoints);
      const statementId = await kit.mutate(command, "add_dispute_statement", [command.disputeId, text], (tx) => creatorOf(tx, command), async (tx) => {
        const row = await dispute(tx, command.disputeId, true); const at = kit.now();
        if (row.state !== "open") resolutionFail("invalid_transition");
        return { resultReference: await add(tx, row, command.actor, text, command.requestId, at), at };
      });
      if (!commissionUuid(statementId)) resolutionFail("dependency_unavailable"); return { statementId };
    },
    async withdrawDispute(command: Target): Promise<{ disputeId: string; orderVersion: number }> {
      enabled(); exact(command, ["disputeId"]); if (!commissionUuid(command.disputeId)) resolutionFail("invalid_request");
      const reference = await kit.mutate(command, "withdraw_dispute", [command.disputeId], (tx) => creatorOf(tx, command, true), async (tx) => {
        const row = await dispute(tx, command.disputeId, true); const order = await owned(tx, row.orderId, command.actor); const at = kit.now();
        if (row.state !== "open") resolutionFail("invalid_transition");
        if (at < row.openedAt) resolutionFail("invalid_request");
        const [ended] = await tx.update(commissionDisputes).set({ state: "withdrawn", closedAt: at, version: row.version + 1 })
          .where(and(eq(commissionDisputes.id, row.id), eq(commissionDisputes.version, row.version), eq(commissionDisputes.state, "open"))).returning();
        if (!ended) resolutionFail("version_conflict");
        let orderVersion = order.version;
        if (order.state === "delivered" && row.orderStateAtOpen === "delivered") {
          const restored = await input.orders.restoreReviewTime(tx, { orderId: order.id, expectedVersion: order.version,
            floorAt: new Date(at.getTime() + Math.max(row.remainingReviewMs ?? 0, RESOLUTION_POLICY.restoreFloorMs)), actor: command.actor, requestId: command.requestId, at });
          orderVersion = restored.version;
        }
        const openCase = await input.cases.findOpenCase(tx, { kind: "dispute", sourceId: row.id });
        if (!openCase) resolutionFail("dependency_unavailable");
        await input.cases.resolveCase(tx, { caseId: openCase.caseId, resolutionKind: "withdrawn", actor: command.actor, reason: null, requestId: command.requestId, at });
        await insertOutboxEvent(tx, { eventType: "resolution.dispute_closed.v1", eventVersion: 1, aggregateType: "commission_dispute", aggregateId: row.id,
          payload: { disputeId: row.id, orderId: row.orderId, state: "withdrawn" }, occurredAt: at });
        return { resultReference: `${row.id}:${orderVersion}`, at };
      });
      const parts = reference.split(":"); const orderVersion = Number(parts[1]);
      if (parts.length !== 2 || !commissionUuid(parts[0]) || !Number.isSafeInteger(orderVersion) || orderVersion < 1 || orderVersion > 2_147_483_647
        || String(orderVersion) !== parts[1]) resolutionFail("dependency_unavailable");
      return { disputeId: parts[0], orderVersion };
    },
  };
}
