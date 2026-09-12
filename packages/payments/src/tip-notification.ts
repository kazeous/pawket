import { paymentConfirmations, paymentIntents, systemOutbox, type PawketTransaction } from "@pawket/database";
import { and, eq } from "drizzle-orm";
import { TipPaymentError } from "./tip-contracts.js";
import { readTipPortRecord } from "./tip-port-boundary.js";

export type TipNotificationSource = Readonly<{ outboxEventId: string; eventType: string; eventVersion: number; aggregateType: string; aggregateId: string }>;
export const TIP_NOTIFICATION_EVENTS = ["tip.created.v1", "tip.confirmed.v1", "tip.expired.v1"] as const;
export async function resolveTipNotificationContext(tx: PawketTransaction, event: TipNotificationSource): Promise<Readonly<{
  creatorUserId: string; paymentIntentId: string; state: "created" | "confirmed" | "expired";
}>> {
  const fail = (): never => { throw new TipPaymentError("dependency_unavailable"); };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(event.outboxEventId) || event.eventVersion !== 1 || !(TIP_NOTIFICATION_EVENTS as readonly string[]).includes(event.eventType)) fail();
  // Serializes handoff creation by source event; the queue payload grants no authority.
  const [source] = await tx.select().from(systemOutbox).where(eq(systemOutbox.id, event.outboxEventId)).limit(1).for("update");
  if (!source || source.eventType !== event.eventType || source.eventVersion !== 1 || source.aggregateType !== event.aggregateType || source.aggregateId !== event.aggregateId) return fail();
  const created = source.eventType === "tip.created.v1"; const confirmed = source.eventType === "tip.confirmed.v1";
  const payload = readTipPortRecord(source.payload, created ? ["tipId", "creatorUserId", "correlationId"] : confirmed ? ["paymentIntentId", "tipId", "creatorUserId", "confirmationId", "correlationId"] : ["paymentIntentId", "tipId", "creatorUserId", "correlationId"]);
  if (!payload || typeof payload.tipId !== "string" || typeof payload.creatorUserId !== "string" || source.aggregateType !== (created ? "tip" : "payment_intent") || source.aggregateId !== (created ? payload.tipId : payload.paymentIntentId)) return fail();
  const [intent] = await tx.select({ id: paymentIntents.id, tipId: paymentIntents.tipId, creatorUserId: paymentIntents.creatorUserId, state: paymentIntents.state, createdAt: paymentIntents.createdAt, closedAt: paymentIntents.closedAt })
    .from(paymentIntents).where(created ? eq(paymentIntents.tipId, source.aggregateId) : eq(paymentIntents.id, source.aggregateId)).limit(1);
  if (!intent || intent.creatorUserId !== payload.creatorUserId || intent.tipId !== payload.tipId) return fail();
  if (created && intent.createdAt.getTime() !== source.occurredAt.getTime()) return fail();
  if (!created && (intent.state !== (confirmed ? "confirmed" : "expired") || intent.closedAt?.getTime() !== source.occurredAt.getTime())) return fail();
  if (confirmed) {
    if (typeof payload.confirmationId !== "string") return fail();
    const [fact] = await tx.select({ id: paymentConfirmations.id }).from(paymentConfirmations).where(and(eq(paymentConfirmations.id, payload.confirmationId), eq(paymentConfirmations.paymentIntentId, intent.id))).limit(1);
    if (!fact) return fail();
  }
  return { creatorUserId: intent.creatorUserId, paymentIntentId: intent.id, state: created ? "created" : confirmed ? "confirmed" : "expired" };
}
