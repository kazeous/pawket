import { and, eq } from "drizzle-orm";
import { appendAdminAuditEvent, insertOutboxEvent, commissionOrders, commissionReservations, commissionEvents, COMMISSION_POST_PAYMENT_CLOSE_REASONS, type PawketTransaction } from "@pawket/database";
import { commissionFail, type CommissionActor, type CommissionCloseReason, type CommissionCompletionKind, type CommissionState, type PostPaymentCloseReason } from "./contracts.js";
import { requireCommissionTransition } from "./lifecycle.js";
import type { CommissionPaymentsPort } from "./ports.js";

type Order = typeof commissionOrders.$inferSelect;
export function commissionExpiredReason(state: string): CommissionCloseReason {
  if (state === "requested") return "request_expired";
  if (state === "quoted") return "quote_expired";
  if (state === "awaiting_payment") return "payment_expired";
  return commissionFail("invalid_transition");
}
export function createCommissionOrderPersistence(input: { applicationRevision: string; newId(): string; payments?: Pick<CommissionPaymentsPort, "closeIntent"> }) {
  async function record(tx: PawketTransaction, order: Order, actor: CommissionActor | null, requestId: string, reason: string | null = order.closeReason) {
    await tx.insert(commissionEvents).values({ id: input.newId(), orderId: order.id, orderVersion: order.version, type: order.state,
      actorUserId: actor?.userId ?? null, actorSessionId: actor?.sessionId ?? null, reason, requestId, occurredAt: order.updatedAt });
    await appendAdminAuditEvent(tx, { actorUserId: actor?.userId ?? "system:commission-worker", actorSessionId: actor?.sessionId ?? null,
      subjectType: "commission_order", subjectId: order.id, action: `commission.${order.state}`, outcome: "succeeded",
      beforeState: null, afterState: { state: order.state, version: order.version, reason },
      assurance: { method: actor ? "current_session" : "worker" }, applicationRevision: input.applicationRevision, requestId, occurredAt: order.updatedAt });
    await insertOutboxEvent(tx, { eventType: `commission.${order.state}.v1`, eventVersion: 1, aggregateType: "commission_order", aggregateId: order.id,
      payload: { orderId: order.id, version: order.version, state: order.state, reason, correlationId: requestId }, occurredAt: order.updatedAt });
  }
  async function completeCommissionOrder(tx: PawketTransaction, order: Order, kind: CommissionCompletionKind, actor: CommissionActor | null, requestId: string, at: Date) {
    requireCommissionTransition(order.state as CommissionState, "completed");
    const [reservation] = await tx.update(commissionReservations).set({ state: "completed", releasedAt: at })
      .where(and(eq(commissionReservations.orderId, order.id), eq(commissionReservations.state, "occupied"))).returning();
    if (!reservation) commissionFail("invalid_transition");
    const [completed] = await tx.update(commissionOrders).set({ state: "completed", completedAt: at, completionKind: kind, version: order.version + 1, updatedAt: at })
      .where(and(eq(commissionOrders.id, order.id), eq(commissionOrders.version, order.version))).returning();
    if (!completed) commissionFail("version_conflict");
    await record(tx, completed, actor, requestId, kind); return completed;
  }
  async function closeOrder(tx: PawketTransaction, order: Order, reason: CommissionCloseReason, actor: CommissionActor | null, requestId: string, at: Date) {
    if (COMMISSION_POST_PAYMENT_CLOSE_REASONS.includes(reason as PostPaymentCloseReason)) commissionFail("invalid_transition");
    requireCommissionTransition(order.state as CommissionState, "closed", reason);
    if (order.acceptedAt) {
      if (reason !== "buyer_cancelled" && reason !== "creator_cancelled" && reason !== "payment_expired" && reason !== "security_invalidated" && reason !== "eligibility_invalidated") commissionFail("invalid_transition");
      if (!input.payments) commissionFail("dependency_unavailable");
      if (!await input.payments.closeIntent(tx, { orderId: order.id, creatorUserId: order.creatorUserId, at, reason })) commissionFail("invalid_transition");
      const [released] = await tx.update(commissionReservations).set({ state: "released", releasedAt: at }).where(and(eq(commissionReservations.orderId, order.id), eq(commissionReservations.state, "reserved"))).returning();
      if (!released) commissionFail("invalid_transition");
    }
    const [closed] = await tx.update(commissionOrders).set({ state: "closed", version: order.version + 1, closeReason: reason, closedAt: at, updatedAt: at })
      .where(and(eq(commissionOrders.id, order.id), eq(commissionOrders.version, order.version))).returning();
    if (!closed) commissionFail("version_conflict");
    await record(tx, closed, actor, requestId); return closed;
  }
  async function closePaidOrder(tx: PawketTransaction, order: Order, reason: PostPaymentCloseReason, actor: CommissionActor | null, requestId: string, at: Date) {
    if (!COMMISSION_POST_PAYMENT_CLOSE_REASONS.includes(reason) || !order.confirmedAt) commissionFail("invalid_transition");
    requireCommissionTransition(order.state as CommissionState, "closed", reason);
    const [reservation] = await tx.update(commissionReservations).set({ state: "cancelled", releasedAt: at })
      .where(and(eq(commissionReservations.orderId, order.id), eq(commissionReservations.state, "occupied"))).returning();
    if (!reservation) commissionFail("invalid_transition");
    const [closed] = await tx.update(commissionOrders).set({ state: "closed", version: order.version + 1, closeReason: reason, closedAt: at, updatedAt: at })
      .where(and(eq(commissionOrders.id, order.id), eq(commissionOrders.version, order.version))).returning();
    if (!closed) commissionFail("version_conflict");
    await record(tx, closed, actor, requestId); return closed;
  }
  return { record, closeOrder, closePaidOrder, completeCommissionOrder };
}
