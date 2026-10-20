import { insertOutboxEvent, type PawketTransaction } from "@pawket/database";

/** Refund actions that notify a party (P1). The others (destination_revealed, deadline_extended, amount_*, destination_purged) stay silent. */
export const REFUND_OUTBOX_ACTIONS = ["created", "destination_entered", "sent_recorded", "receipt_confirmed", "receipt_denied",
  "presumed_received", "resend_required", "waived"] as const;
export type RefundOutboxAction = (typeof REFUND_OUTBOX_ACTIONS)[number];

/** Called by both refund `event()` helpers in the transaction that inserts the refund event.
 * The payload names the committed rows and the action; amounts, bank data, notes and references never enter the outbox. */
export async function announceRefundEvent(tx: PawketTransaction, event: Readonly<{ obligationId: string; refundEventId: string; action: string; occurredAt: Date }>): Promise<void> {
  if (!(REFUND_OUTBOX_ACTIONS as readonly string[]).includes(event.action)) return;
  await insertOutboxEvent(tx, { eventType: "refund.event_recorded.v1", eventVersion: 1, aggregateType: "commission_refund_obligation", aggregateId: event.obligationId,
    payload: { obligationId: event.obligationId, refundEventId: event.refundEventId, action: event.action }, occurredAt: event.occurredAt });
}
