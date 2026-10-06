import { and, eq } from "drizzle-orm";
import { adminAuditEvents, commissionEvents, commissionMessages, commissionSubmissions, commissionThreadEntries,
  paymentConfirmations, paymentIntents, paymentTransferClaims, systemOutbox, type PawketDatabase } from "@pawket/database";
import { commissionUuid, readCommissionRecord } from "@pawket/orders";
import type { SystemOutboxJob } from "@pawket/queue";

export const COMMISSION_OUTBOX_EVENTS = new Set([
  "commission.requested.v1", "commission.quoted.v1", "commission.awaiting_payment.v1", "commission.closed.v1", "commission.confirmed.v1",
  "commission.transfer_claimed.v1",
  "commission.in_progress.v1", "commission.delivered.v1", "commission.completed.v1",
  "commission.message_sent.v1", "commission.submission_sent.v1", "commission.submission_responded.v1",
  "commission.catalog.draft_saved.v1", "commission.catalog.publish.v1", "commission.catalog.pause.v1", "commission.catalog.archive.v1", "commission.catalog.settings_saved.v1",
]);

/** Private status is served directly from committed records. This technical
 * consumer validates the durable event binding before ack; it promises no email
 * or other business side effect and never routes commission content to tip mail. */
export async function validateCommissionOutboxEvent(db: PawketDatabase, event: SystemOutboxJob): Promise<void> {
  const invalid = (): never => { throw new Error("Invalid commission worker source"); };
  if (!commissionUuid(event.outboxEventId) || !COMMISSION_OUTBOX_EVENTS.has(event.eventType) || event.eventVersion !== 1) invalid();
  const [source] = await db.select().from(systemOutbox).where(eq(systemOutbox.id, event.outboxEventId)).limit(1);
  if (!source || source.eventType !== event.eventType || source.eventVersion !== event.eventVersion || source.aggregateType !== event.aggregateType ||
    source.aggregateId !== event.aggregateId || source.occurredAt.toISOString() !== event.occurredAt) invalid();
  const expected = source!.payload; const payload = readCommissionRecord(event.payload, Object.keys(expected));
  if (!payload || Object.keys(expected).some((key) => payload[key] !== expected[key])) invalid();
  if (event.eventType === "commission.confirmed.v1") {
    if (event.aggregateType !== "payment_intent" || !readCommissionRecord(expected, ["paymentIntentId", "orderId", "creatorUserId", "confirmationId", "correlationId"]) ||
      expected.paymentIntentId !== event.aggregateId || !commissionUuid(expected.confirmationId)) invalid();
    const [row] = await db.select({ intent: paymentIntents, confirmation: paymentConfirmations }).from(paymentIntents)
      .innerJoin(paymentConfirmations, eq(paymentConfirmations.paymentIntentId, paymentIntents.id)).where(eq(paymentIntents.id, event.aggregateId)).limit(1);
    if (!row || row.intent.purpose !== "commission" || row.intent.tipId !== null || row.intent.commissionOrderId !== expected.orderId || row.intent.creatorUserId !== expected.creatorUserId ||
      row.intent.state !== "confirmed" || row.confirmation.id !== expected.confirmationId || row.confirmation.requestId !== expected.correlationId || row.confirmation.confirmedAt.toISOString() !== event.occurredAt) invalid();
  } else if (event.eventType === "commission.transfer_claimed.v1") {
    if (event.aggregateType !== "commission_order" || !readCommissionRecord(expected, ["orderId", "claimId", "buyerUserId", "correlationId"]) ||
      expected.orderId !== event.aggregateId || !commissionUuid(expected.claimId)) invalid();
    const [row] = await db.select({ intent: paymentIntents, claim: paymentTransferClaims }).from(paymentTransferClaims)
      .innerJoin(paymentIntents, eq(paymentIntents.id, paymentTransferClaims.paymentIntentId)).where(eq(paymentTransferClaims.id, expected.claimId as string)).limit(1);
    if (!row || row.intent.purpose !== "commission" || row.intent.tipId !== null || row.intent.commissionOrderId !== event.aggregateId ||
      row.claim.accessKind !== "buyer" || row.claim.buyerUserId !== expected.buyerUserId || row.claim.requestId !== expected.correlationId || row.claim.claimedAt.toISOString() !== event.occurredAt) invalid();
  } else if (event.eventType === "commission.message_sent.v1") {
    if (event.aggregateType !== "commission_order" || !readCommissionRecord(expected, ["orderId", "messageId", "sequence", "correlationId"]) ||
      expected.orderId !== event.aggregateId || !commissionUuid(expected.messageId) || !Number.isSafeInteger(expected.sequence) ||
      typeof expected.sequence !== "number" || expected.sequence < 1) invalid();
    const [row] = await db.select({ orderId: commissionMessages.orderId, requestId: commissionMessages.requestId,
      createdAt: commissionMessages.createdAt, sequence: commissionThreadEntries.sequence }).from(commissionMessages)
      .innerJoin(commissionThreadEntries, and(eq(commissionThreadEntries.entryId, commissionMessages.id),
        eq(commissionThreadEntries.orderId, commissionMessages.orderId), eq(commissionThreadEntries.kind, "message")))
      .where(eq(commissionMessages.id, expected.messageId as string)).limit(1);
    if (!row || row.orderId !== event.aggregateId || row.sequence !== expected.sequence || row.requestId !== expected.correlationId ||
      row.createdAt.toISOString() !== event.occurredAt) invalid();
  } else if (event.eventType === "commission.submission_sent.v1") {
    if (event.aggregateType !== "commission_order" || !readCommissionRecord(expected, ["orderId", "submissionId", "kind", "sequence", "correlationId"]) ||
      expected.orderId !== event.aggregateId || !commissionUuid(expected.submissionId) || !Number.isSafeInteger(expected.sequence) ||
      typeof expected.sequence !== "number" || expected.sequence < 1 || (expected.kind !== "draft" && expected.kind !== "final")) invalid();
    const [row] = await db.select({ orderId: commissionSubmissions.orderId, kind: commissionSubmissions.kind, requestId: commissionSubmissions.requestId,
      submittedAt: commissionSubmissions.submittedAt, sequence: commissionThreadEntries.sequence }).from(commissionSubmissions)
      .innerJoin(commissionThreadEntries, and(eq(commissionThreadEntries.entryId, commissionSubmissions.id),
        eq(commissionThreadEntries.orderId, commissionSubmissions.orderId), eq(commissionThreadEntries.kind, "submission")))
      .where(eq(commissionSubmissions.id, expected.submissionId as string)).limit(1);
    if (!row || row.orderId !== event.aggregateId || row.kind !== expected.kind || row.sequence !== expected.sequence || row.requestId !== expected.correlationId ||
      row.submittedAt.toISOString() !== event.occurredAt) invalid();
  } else if (event.eventType === "commission.submission_responded.v1") {
    if (event.aggregateType !== "commission_order" || !readCommissionRecord(expected, ["orderId", "submissionId", "response", "correlationId"]) ||
      expected.orderId !== event.aggregateId || !commissionUuid(expected.submissionId) ||
      (expected.response !== "approved" && expected.response !== "changes_requested")) invalid();
    const [row] = await db.select({ orderId: commissionSubmissions.orderId, response: commissionSubmissions.response,
      requestId: commissionSubmissions.responseRequestId, respondedAt: commissionSubmissions.respondedAt }).from(commissionSubmissions)
      .where(eq(commissionSubmissions.id, expected.submissionId as string)).limit(1);
    if (!row || row.orderId !== event.aggregateId || row.response !== expected.response || row.requestId !== expected.correlationId ||
      row.respondedAt?.toISOString() !== event.occurredAt) invalid();
  } else if (event.eventType.startsWith("commission.catalog.")) {
    if (event.aggregateType !== "commission_catalog" || !readCommissionRecord(expected, ["reference", "actorUserId", "correlationId"]) ||
      expected.reference !== event.aggregateId || typeof expected.actorUserId !== "string" || typeof expected.correlationId !== "string") invalid();
    const action = event.eventType.replace("commission.catalog.", "commission.").replace(/\.v1$/u, "");
    const [audit] = await db.select({ id: adminAuditEvents.id }).from(adminAuditEvents).where(and(eq(adminAuditEvents.subjectType, "commission_catalog"),
      eq(adminAuditEvents.subjectId, event.aggregateId), eq(adminAuditEvents.action, action), eq(adminAuditEvents.actorUserId, expected.actorUserId as string),
      eq(adminAuditEvents.requestId, expected.correlationId as string), eq(adminAuditEvents.occurredAt, source!.occurredAt), eq(adminAuditEvents.outcome, "succeeded"))).limit(1);
    if (!audit) invalid();
  } else {
    if (event.aggregateType !== "commission_order" || !readCommissionRecord(expected, ["orderId", "version", "state", "reason", "correlationId"]) ||
      expected.orderId !== event.aggregateId || !Number.isInteger(expected.version) || typeof expected.version !== "number" || expected.version < 1) invalid();
    const [fact] = await db.select().from(commissionEvents).where(and(eq(commissionEvents.orderId, event.aggregateId), eq(commissionEvents.orderVersion, expected.version as number))).limit(1);
    if (!fact || fact.type !== expected.state || `commission.${fact.type}.v1` !== event.eventType || fact.reason !== expected.reason ||
      fact.requestId !== expected.correlationId || fact.occurredAt.toISOString() !== event.occurredAt) invalid();
  }
}
