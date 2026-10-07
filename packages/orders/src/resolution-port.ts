import { and, asc, eq, inArray } from "drizzle-orm";
import { commissionOrders, commissionTermsSnapshots, type PawketTransaction } from "@pawket/database";
import { commissionFail, type CommissionActor, type CommissionCloseReason, type CommissionState, type PostPaymentCloseReason } from "./contracts.js";
import { readCommissionCompletionDueAt } from "./fulfillment-service.js";
import { createCommissionOrderPersistence } from "./order-persistence.js";
import { lockCommissionCreator } from "./payment-lifecycle.js";
import { commissionIdentifier, commissionInteger, commissionTime, commissionUuid } from "./policy.js";

type Order = typeof commissionOrders.$inferSelect;
type Command = Readonly<{ orderId: string; expectedVersion: number; actor: CommissionActor | null; requestId: string; at: Date }>;
export type CommissionResolutionOrderFacts = Readonly<{
  id: string; version: number; state: CommissionState; creatorUserId: string; buyerUserId: string; amountVnd: number | null;
  acceptedAt: Date | null; confirmedAt: Date | null; dueAt: Date | null; deliveredAt: Date | null; reviewEndsAt: Date | null;
  completionFloorAt: Date | null; closedAt: Date | null; closeReason: CommissionCloseReason | null; policyRevisionId: string | null;
}>;

/** Resolution services own authorization/idempotency; this port shares their transaction and creator fence. */
export function createCommissionResolutionOrderPort(input: { applicationRevision: string; newId(): string }) {
  if (!commissionIdentifier(input.applicationRevision)) commissionFail("invalid_request");
  const newId = () => { const id = input.newId(); if (!commissionUuid(id)) commissionFail("dependency_unavailable"); return id; };
  const persistence = createCommissionOrderPersistence({ applicationRevision: input.applicationRevision, newId });
  async function lockOrderRow(tx: PawketTransaction, orderId: string): Promise<Order | null> {
    if (!commissionUuid(orderId)) commissionFail("invalid_request");
    const [candidate] = await tx.select({ creatorUserId: commissionOrders.creatorUserId }).from(commissionOrders).where(eq(commissionOrders.id, orderId)).limit(1);
    if (!candidate) return null;
    await lockCommissionCreator(tx, candidate.creatorUserId);
    const [order] = await tx.select().from(commissionOrders).where(eq(commissionOrders.id, orderId)).limit(1).for("update");
    return order ?? null;
  }
  async function expectedOrder(tx: PawketTransaction, command: Command): Promise<Order> {
    commissionInteger(command.expectedVersion, 1, 2_147_483_646); commissionTime(command.at);
    if (!commissionIdentifier(command.requestId) || (command.actor !== null &&
      (!command.actor || !commissionIdentifier(command.actor.userId) || !commissionIdentifier(command.actor.sessionId)))) commissionFail("invalid_request");
    const order = await lockOrderRow(tx, command.orderId);
    if (!order) commissionFail("not_available");
    if (order.version !== command.expectedVersion) commissionFail("version_conflict");
    return order;
  }
  return {
    async lockOrder(tx: PawketTransaction, orderId: string): Promise<CommissionResolutionOrderFacts | null> {
      const order = await lockOrderRow(tx, orderId); if (!order) return null;
      const [terms] = await tx.select({ policyRevisionId: commissionTermsSnapshots.policyRevisionId }).from(commissionTermsSnapshots)
        .where(eq(commissionTermsSnapshots.orderId, order.id)).limit(1);
      return { id: order.id, version: order.version, state: order.state as CommissionState, creatorUserId: order.creatorUserId, buyerUserId: order.buyerUserId,
        amountVnd: order.amountVnd, acceptedAt: order.acceptedAt, confirmedAt: order.confirmedAt, dueAt: order.dueAt, deliveredAt: order.deliveredAt,
        reviewEndsAt: order.reviewEndsAt, completionFloorAt: order.completionFloorAt, closedAt: order.closedAt,
        closeReason: order.closeReason as CommissionCloseReason | null, policyRevisionId: terms?.policyRevisionId ?? null };
    },
    async closePaidOrder(tx: PawketTransaction, command: Command & Readonly<{ reason: PostPaymentCloseReason }>): Promise<{ version: number }> {
      const order = await expectedOrder(tx, command);
      const closed = await persistence.closePaidOrder(tx, order, command.reason, command.actor, command.requestId, command.at);
      return { version: closed.version };
    },
    async completeByResolution(tx: PawketTransaction, command: Command & Readonly<{ kind: "agreement" | "ruling" }>): Promise<{ version: number }> {
      if (command.kind !== "agreement" && command.kind !== "ruling") commissionFail("invalid_request");
      const order = await expectedOrder(tx, command);
      const completed = await persistence.completeCommissionOrder(tx, order, command.kind, command.actor, command.requestId, command.at);
      return { version: completed.version };
    },
    async restoreReviewTime(tx: PawketTransaction, command: Command & Readonly<{ floorAt: Date }>): Promise<{ version: number }> {
      commissionTime(command.floorAt); const order = await expectedOrder(tx, command);
      if (order.state !== "delivered" || !order.reviewEndsAt) commissionFail("invalid_transition");
      const base = Math.max(order.reviewEndsAt.getTime(), (order.completionFloorAt ?? order.reviewEndsAt).getTime());
      if (command.floorAt.getTime() <= base) return { version: order.version };
      const [restored] = await tx.update(commissionOrders).set({ completionFloorAt: command.floorAt, version: order.version + 1, updatedAt: command.at })
        .where(and(eq(commissionOrders.id, order.id), eq(commissionOrders.version, order.version))).returning();
      if (!restored) commissionFail("version_conflict");
      await persistence.record(tx, restored, command.actor, command.requestId, "review_time_restored");
      return { version: restored.version };
    },
    async completionDueAt(tx: PawketTransaction, orderId: string): Promise<Date | null> {
      const order = await lockOrderRow(tx, orderId);
      return order?.reviewEndsAt ? readCommissionCompletionDueAt(tx, { reviewEndsAt: order.reviewEndsAt, completionFloorAt: order.completionFloorAt }) : null;
    },
    async listLiveOrders(tx: PawketTransaction, creatorUserId: string): Promise<readonly { orderId: string; version: number }[]> {
      await lockCommissionCreator(tx, creatorUserId);
      return tx.select({ orderId: commissionOrders.id, version: commissionOrders.version }).from(commissionOrders)
        .where(and(eq(commissionOrders.creatorUserId, creatorUserId), inArray(commissionOrders.state, ["in_progress", "delivered"]))).orderBy(asc(commissionOrders.id));
    },
  };
}
