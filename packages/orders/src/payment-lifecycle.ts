import { randomUUID } from "node:crypto";
import { commissionEvents, commissionOrders, commissionReservations, commissionTermsSnapshots, type PawketTransaction } from "@pawket/database";
import { and, eq, gt, sql } from "drizzle-orm";
import { commissionDueAt, commissionIdentifier, commissionTime, commissionUuid } from "./policy.js";
import type { CommissionActor } from "./contracts.js";

/** First domain lock for every commission writer, before identity and financial locks. */
export async function lockCommissionCreator(tx: PawketTransaction, creatorUserId: string): Promise<void> {
  if (!commissionIdentifier(creatorUserId)) throw new Error("Invalid commission creator fence");
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`commissions:creator:${creatorUserId}`}, 0))`);
}

type Binding = Readonly<{ orderId: string; creatorUserId: string; at: Date }>;
type Confirmation = Binding & Readonly<{
  paymentIntentId: string; amountVnd: number; actor: CommissionActor | null; requestId: string;
}>;
type Input = Readonly<{
  eligibility: {
    // Identity/Trust locks both participants and capability eligibility until commit.
    // Intake/package pause is intentionally independent of a previously opened payment.
    lockSettlementParticipants(tx: PawketTransaction, command: { creatorUserId: string; buyerUserId: string; at: Date }): Promise<boolean>;
  };
  idFactory?: () => string;
}>;

/** Payments calls this port inside its confirmation transaction; no Payments table writes here. */
export function createCommissionPaymentLifecyclePort(input: Input) {
  const id = input.idFactory ?? randomUUID;
  const locked = new WeakMap<PawketTransaction, Map<string, { creatorUserId: string; at: number }>>();
  return {
    async lockSettlement(tx: PawketTransaction, command: Binding): Promise<boolean> {
      if (!commissionUuid(command.orderId) || !commissionIdentifier(command.creatorUserId)) return false;
      const at = commissionTime(command.at);
      await lockCommissionCreator(tx, command.creatorUserId);
      const [order] = await tx.select().from(commissionOrders).where(and(eq(commissionOrders.id, command.orderId), eq(commissionOrders.creatorUserId, command.creatorUserId))).limit(1);
      if (!order || (order.state !== "awaiting_payment" && order.state !== "in_progress") ||
        (order.state === "awaiting_payment" && (!order.expiresAt || order.expiresAt <= command.at)) ||
        !await input.eligibility.lockSettlementParticipants(tx, { creatorUserId: order.creatorUserId, buyerUserId: order.buyerUserId, at: command.at })) return false;
      const bindings = locked.get(tx) ?? new Map();
      bindings.set(command.orderId, { creatorUserId: command.creatorUserId, at }); locked.set(tx, bindings);
      return true;
    },
    async confirmPayment(tx: PawketTransaction, command: Confirmation): Promise<boolean> {
      const binding = locked.get(tx)?.get(command.orderId);
      if (!binding || binding.creatorUserId !== command.creatorUserId || binding.at > commissionTime(command.at) ||
        !commissionUuid(command.paymentIntentId) || !commissionIdentifier(command.requestId) ||
        (command.actor !== null && (command.actor.userId !== command.creatorUserId || !commissionIdentifier(command.actor.sessionId)))) return false;
      const [order] = await tx.select().from(commissionOrders).where(and(eq(commissionOrders.id, command.orderId), eq(commissionOrders.creatorUserId, command.creatorUserId))).limit(1).for("update");
      if (!order || order.state !== "awaiting_payment" || order.amountVnd !== command.amountVnd || !order.acceptedAt || order.acceptedAt > command.at ||
        !order.expiresAt || order.expiresAt <= command.at) return false;
      const [terms] = await tx.select().from(commissionTermsSnapshots).where(eq(commissionTermsSnapshots.orderId, order.id)).limit(1);
      if (!terms || terms.amountVnd !== command.amountVnd) return false;
      const [reservation] = await tx.update(commissionReservations).set({ state: "occupied", occupiedAt: command.at })
        .where(and(eq(commissionReservations.orderId, order.id), eq(commissionReservations.creatorUserId, command.creatorUserId), eq(commissionReservations.state, "reserved"))).returning();
      if (!reservation) return false;
      const [updated] = await tx.update(commissionOrders).set({ state: "in_progress", version: order.version + 1, confirmedAt: command.at,
        dueAt: commissionDueAt(command.at, terms.turnaroundDays), updatedAt: command.at })
        .where(and(eq(commissionOrders.id, order.id), eq(commissionOrders.version, order.version), eq(commissionOrders.state, "awaiting_payment"), gt(commissionOrders.expiresAt, command.at))).returning();
      if (!updated) return false;
      const eventId = id(); if (!commissionUuid(eventId)) throw new Error("Invalid commission event identity");
      await tx.insert(commissionEvents).values({ id: eventId, orderId: order.id, orderVersion: updated.version, type: "in_progress",
        actorUserId: command.actor?.userId ?? null, actorSessionId: command.actor?.sessionId ?? null, requestId: command.requestId, occurredAt: command.at });
      return true;
    },
  };
}
