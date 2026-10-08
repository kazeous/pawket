import { and, eq } from "drizzle-orm";
import { adminAuditEvents, commissionDisputes, commissionDisputeStatements, commissionLatePaymentClaims, commissionProposals,
  commissionRulings, commissionRulingCorrections, systemOutbox, trustCases, trustCaseEvents, type PawketDatabase } from "@pawket/database";
import { commissionUuid, readCommissionRecord } from "@pawket/orders";
import type { SystemOutboxJob } from "@pawket/queue";

export const RESOLUTION_OUTBOX_EVENTS = new Set([
  "trust.case_opened.v1", "resolution.proposal_made.v1", "resolution.proposal_ended.v1", "resolution.dispute_opened.v1",
  "resolution.dispute_statement_added.v1", "resolution.dispute_closed.v1", "resolution.ruling_recorded.v1", "resolution.ruling_corrected.v1",
  "resolution.late_claim_filed.v1", "resolution.late_claim_ended.v1", "resolution.fulfillment_frozen.v1",
]);

/** Validate committed facts before acknowledgement. Historical creation events remain
 * valid after a source ends; mutable states must be backed by their durable transition. */
export async function validateResolutionOutboxEvent(db: PawketDatabase, event: SystemOutboxJob): Promise<void> {
  const invalid = (): never => { throw new Error("Invalid resolution worker source"); };
  if (!commissionUuid(event.outboxEventId) || !RESOLUTION_OUTBOX_EVENTS.has(event.eventType) || event.eventVersion !== 1) invalid();
  const [source] = await db.select().from(systemOutbox).where(eq(systemOutbox.id, event.outboxEventId)).limit(1);
  if (!source || source.eventType !== event.eventType || source.eventVersion !== event.eventVersion || source.aggregateType !== event.aggregateType ||
    source.aggregateId !== event.aggregateId || source.occurredAt.toISOString() !== event.occurredAt) invalid();
  const expected = source!.payload; const payload = readCommissionRecord(event.payload, Object.keys(expected));
  if (!payload || Object.keys(expected).some((key) => payload[key] !== expected[key])) invalid();
  const shape = (aggregate: string, keys: readonly string[], id: string) => {
    if (event.aggregateType !== aggregate || !readCommissionRecord(expected, keys) || expected[id] !== event.aggregateId) invalid();
    for (const key of keys.filter((key) => key.endsWith("Id") && key !== "creatorUserId" && key !== "correlationId")) {
      if (!(key === "policyRevisionId" && expected[key] === null) && !commissionUuid(expected[key])) invalid();
    }
  };
  const time = (at: Date | null | undefined) => at?.toISOString() === event.occurredAt;
  if (event.eventType === "trust.case_opened.v1") {
    shape("trust_case", ["caseId", "orderId", "sourceId", "policyRevisionId", "correlationId"], "caseId");
    const [row] = await db.select({ case: trustCases, opened: trustCaseEvents }).from(trustCases)
      .innerJoin(trustCaseEvents, and(eq(trustCaseEvents.caseId, trustCases.id), eq(trustCaseEvents.action, "opened")))
      .where(eq(trustCases.id, event.aggregateId)).limit(1);
    if (!row || !["open", "resolved"].includes(row.case.state) || row.case.orderId !== expected.orderId || row.case.sourceId !== expected.sourceId ||
      row.case.policyRevisionId !== expected.policyRevisionId || row.opened.requestId !== expected.correlationId || row.opened.afterState !== "open" || !time(row.case.openedAt) || !time(row.opened.occurredAt)) invalid();
  } else if (event.eventType.startsWith("resolution.proposal_")) {
    const made = event.eventType === "resolution.proposal_made.v1";
    shape("commission_proposal", ["proposalId", "orderId", made ? "kind" : "state"], "proposalId");
    const [row] = await db.select().from(commissionProposals).where(eq(commissionProposals.id, event.aggregateId)).limit(1);
    if (!row || row.orderId !== expected.orderId || (made ? row.kind !== expected.kind || !time(row.createdAt) :
      row.state !== expected.state || !["accepted", "declined", "withdrawn", "expired", "lapsed", "superseded"].includes(row.state) || !time(row.endedAt))) invalid();
  } else if (event.eventType === "resolution.dispute_statement_added.v1") {
    shape("commission_dispute", ["disputeId", "statementId", "authorRole"], "disputeId");
    const [row] = await db.select().from(commissionDisputeStatements).where(eq(commissionDisputeStatements.id, expected.statementId as string)).limit(1);
    if (!row || row.disputeId !== event.aggregateId || row.authorRole !== expected.authorRole || row.kind === "opening" || !time(row.createdAt)) invalid();
  } else if (event.eventType.startsWith("resolution.dispute_")) {
    const opened = event.eventType === "resolution.dispute_opened.v1";
    shape("commission_dispute", opened ? ["disputeId", "orderId"] : ["disputeId", "orderId", "state"], "disputeId");
    const [row] = await db.select().from(commissionDisputes).where(eq(commissionDisputes.id, event.aggregateId)).limit(1);
    if (!row || row.orderId !== expected.orderId || (opened ? !time(row.openedAt) : row.state !== expected.state ||
      !["withdrawn", "settled", "ruled", "superseded"].includes(row.state) || !time(row.closedAt))) invalid();
  } else if (event.eventType === "resolution.ruling_recorded.v1") {
    shape("commission_ruling", ["rulingId", "disputeId", "orderId", "outcome"], "rulingId");
    const [row] = await db.select({ ruling: commissionRulings, dispute: commissionDisputes }).from(commissionRulings)
      .innerJoin(commissionDisputes, eq(commissionDisputes.id, commissionRulings.disputeId)).where(eq(commissionRulings.id, event.aggregateId)).limit(1);
    if (!row || row.ruling.disputeId !== expected.disputeId || row.dispute.orderId !== expected.orderId || row.dispute.state !== "ruled" ||
      row.ruling.outcome !== expected.outcome || !time(row.ruling.ruledAt)) invalid();
  } else if (event.eventType === "resolution.ruling_corrected.v1") {
    shape("commission_ruling_correction", ["correctionId", "rulingId", "effect"], "correctionId");
    const [row] = await db.select().from(commissionRulingCorrections).where(eq(commissionRulingCorrections.id, event.aggregateId)).limit(1);
    if (!row || row.rulingId !== expected.rulingId || row.effect !== expected.effect || !time(row.correctedAt)) invalid();
  } else if (event.eventType.startsWith("resolution.late_claim_")) {
    const filed = event.eventType === "resolution.late_claim_filed.v1";
    shape("commission_late_payment_claim", filed ? ["claimId", "orderId"] : ["claimId", "orderId", "state"], "claimId");
    const [row] = await db.select().from(commissionLatePaymentClaims).where(eq(commissionLatePaymentClaims.id, event.aggregateId)).limit(1);
    if (!row || row.orderId !== expected.orderId) invalid();
    if (filed) { if (!time(row!.filedAt)) invalid(); }
    else if (expected.state === "escalated") {
      // Escalation has no ended_at and can later become refund_owed/rejected.
      const [opened] = await db.select({ id: trustCases.id }).from(trustCases).where(and(eq(trustCases.kind, "late_payment"),
        eq(trustCases.sourceId, event.aggregateId), eq(trustCases.orderId, row!.orderId), eq(trustCases.openedAt, source!.occurredAt))).limit(1);
      if (!opened || !["escalated", "refund_owed", "rejected"].includes(row!.state)) invalid();
    } else if (row!.state !== expected.state || !["refund_owed", "rejected"].includes(row!.state) || !time(row!.endedAt)) invalid();
  } else if (event.eventType === "resolution.fulfillment_frozen.v1") {
    shape("creator", ["creatorUserId", "closedOrders"], "creatorUserId");
    if (!Number.isSafeInteger(expected.closedOrders) || typeof expected.closedOrders !== "number" || expected.closedOrders < 0) invalid();
    const rows = await db.select({ afterState: adminAuditEvents.afterState }).from(adminAuditEvents).where(and(
      eq(adminAuditEvents.subjectType, "identity_user"), eq(adminAuditEvents.subjectId, event.aggregateId), eq(adminAuditEvents.action, "owner.commission_fulfillment_freeze"),
      eq(adminAuditEvents.outcome, "succeeded"), eq(adminAuditEvents.occurredAt, source!.occurredAt)));
    if (!rows.some((row) => row.afterState?.closedOrders === expected.closedOrders && row.afterState?.standing === "suspended")) invalid();
  } else invalid();
}
