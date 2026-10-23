import { and, eq } from "drizzle-orm";
import { commissionRefundEvents, systemOutbox, type PawketDatabase } from "@pawket/database";
import { commissionUuid, readCommissionRecord } from "@pawket/orders";
import { REFUND_OUTBOX_ACTIONS } from "@pawket/payments";
import type { SystemOutboxJob } from "@pawket/queue";

export const REFUND_OUTBOX_EVENTS = new Set(["refund.event_recorded.v1"]);

/** Validates the durable refund event binding before acknowledgement. The queue payload grants no authority:
 * the committed outbox row and the committed `commission_refund_events` row must agree on obligation, action and time. */
export async function validateRefundOutboxEvent(db: PawketDatabase, event: SystemOutboxJob): Promise<void> {
  const invalid = (): never => { throw new Error("Invalid refund worker source"); };
  if (!commissionUuid(event.outboxEventId) || !REFUND_OUTBOX_EVENTS.has(event.eventType) || event.eventVersion !== 1) invalid();
  const [source] = await db.select().from(systemOutbox).where(eq(systemOutbox.id, event.outboxEventId)).limit(1);
  if (!source || source.eventType !== event.eventType || source.eventVersion !== event.eventVersion || source.aggregateType !== event.aggregateType ||
    source.aggregateId !== event.aggregateId || source.occurredAt.toISOString() !== event.occurredAt) invalid();
  const expected = source!.payload; const payload = readCommissionRecord(event.payload, Object.keys(expected));
  if (!payload || Object.keys(expected).some((key) => payload[key] !== expected[key])) invalid();
  if (event.aggregateType !== "commission_refund_obligation" || !readCommissionRecord(expected, ["obligationId", "refundEventId", "action"]) ||
    expected.obligationId !== event.aggregateId || !commissionUuid(expected.obligationId) || !commissionUuid(expected.refundEventId) ||
    typeof expected.action !== "string" || !(REFUND_OUTBOX_ACTIONS as readonly string[]).includes(expected.action)) invalid();
  const [fact] = await db.select({ action: commissionRefundEvents.action, occurredAt: commissionRefundEvents.occurredAt }).from(commissionRefundEvents)
    .where(and(eq(commissionRefundEvents.id, expected.refundEventId as string), eq(commissionRefundEvents.obligationId, event.aggregateId))).limit(1);
  if (!fact || fact.action !== expected.action || fact.occurredAt.toISOString() !== event.occurredAt) invalid();
}
