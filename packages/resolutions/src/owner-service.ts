import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { appendAdminAuditEvent, commissionDisputes, commissionDisputeStatements, commissionProposals, commissionRulings,
  commissionRulingCorrections, insertOutboxEvent, type PawketTransaction } from "@pawket/database";
import { commissionIdentifier, commissionTime, commissionUuid, readCommissionRecord } from "@pawket/orders";
import { resolutionFail, RULING_OUTCOMES, type ResolutionOwnerCommand, type RulingOutcome } from "./contracts.js";
import type { createResolutionCommandKit } from "./command-kit.js";
import { effectiveResolutionDeadline } from "./deadlines.js";
import { normalizeResolutionText, RESOLUTION_POLICY } from "./policy.js";
import { isLatePaymentOrder, lateClaimAmountValid, readLatePaymentClaim, recordLateClaimState } from "./late-claim-service.js";
import { closeSuspendedPaidOrder } from "./suspension-service.js";
import type { ResolutionOrderPort, ResolutionRefundPort, ResolutionPaymentFactsPort, ResolutionCasePort, ResolutionStandingPort } from "./ports.js";

type Kit = ReturnType<typeof createResolutionCommandKit>;
type Input = Readonly<{ orders: ResolutionOrderPort; refunds: ResolutionRefundPort; payments: ResolutionPaymentFactsPort;
  cases: ResolutionCasePort; mode: "disabled" | "enabled"; applicationRevision: string; standing?: ResolutionStandingPort }>;
type Target = ResolutionOwnerCommand & Readonly<{ disputeId: string }>;
type Rule = Target & Readonly<{ outcome: RulingOutcome; refundAmountVnd: number; reasoning: string; internalNote?: string }>;
type Correct = ResolutionOwnerCommand & Readonly<{ rulingId: string; newRefundAmountVnd: number; reason: string }>;
type RefundAction = "accept_evidence" | "require_resend" | "waive" | "extend_deadline";
type Refund = ResolutionOwnerCommand & Readonly<{ caseId: string; action: RefundAction; until?: Date; reason: string }>;
type LateClaim = ResolutionOwnerCommand & Readonly<{ claimId: string; outcome: "refund_owed" | "rejected"; amountVnd?: number; reason: string }>;
type Freeze = ResolutionOwnerCommand & Readonly<{ creatorUserId: string; reason: string }>;
type CorrectionEffect = "increased" | "reduced" | "waived" | "recorded_only";
const effects: readonly CorrectionEffect[] = ["increased", "reduced", "waived", "recorded_only"];
const commandKeys = ["owner", "stepUpProofId", "idempotencyKey", "requestId"];
function exact(command: unknown, keys: readonly string[], optional: readonly string[] = []) {
  if (!readCommissionRecord(command, [...commandKeys, ...keys])
    && !readCommissionRecord(command, [...commandKeys, ...keys, ...optional])) resolutionFail("invalid_request");
}
const amountValid = (amount: number) => Number.isSafeInteger(amount) && amount >= 0 && amount <= 50_000_000;
function resultId(reference: string) { if (!commissionUuid(reference)) resolutionFail("dependency_unavailable"); return reference; }

/** Owner authorization is supplied by the kit's consumable, action-bound step-up proof. */
export function createOwnerResolutionService(kit: Kit, input: Input) {
  if (!["enabled", "disabled"].includes(input.mode) || !commissionIdentifier(input.applicationRevision)) resolutionFail("invalid_request");
  const enabled = () => { if (input.mode !== "enabled") resolutionFail("resolution_disabled"); };
  async function order(tx: PawketTransaction, orderId: string) {
    const row = await input.orders.lockOrder(tx, orderId); if (!row) resolutionFail("not_available"); return row;
  }
  async function dispute(tx: PawketTransaction, disputeId: string, locked = false) {
    const query = tx.select().from(commissionDisputes).where(eq(commissionDisputes.id, disputeId)).limit(1);
    const [row] = await (locked ? query.for("update") : query); if (!row) resolutionFail("not_available"); return row;
  }
  async function ruling(tx: PawketTransaction, rulingId: string) {
    const [row] = await tx.select().from(commissionRulings).where(eq(commissionRulings.id, rulingId)).limit(1);
    if (!row) resolutionFail("not_available"); return row;
  }
  const disputeCreator = async (tx: PawketTransaction, disputeId: string) => (await order(tx, (await dispute(tx, disputeId)).orderId)).creatorUserId;
  const rulingCreator = async (tx: PawketTransaction, rulingId: string) => disputeCreator(tx, (await ruling(tx, rulingId)).disputeId);
  async function refundCase(tx: PawketTransaction, caseId: string) {
    const row = await input.cases.readCase(tx, caseId);
    if (!row || !["refund_not_received", "refund_overdue"].includes(row.kind) || row.sourceType !== "commission_refund_obligation") resolutionFail("not_available");
    return row;
  }
  async function openDisputeCase(tx: PawketTransaction, disputeId: string) {
    const row = await input.cases.findOpenCase(tx, { kind: "dispute", sourceId: disputeId });
    if (!row) resolutionFail("dependency_unavailable"); return row;
  }
  async function audit(tx: PawketTransaction, command: ResolutionOwnerCommand, action: string, subjectType: string, subjectId: string,
    beforeState: Record<string, unknown>, afterState: Record<string, unknown>, at: Date) {
    await appendAdminAuditEvent(tx, { actorUserId: command.owner.userId, actorSessionId: command.owner.sessionId,
      subjectType, subjectId, action, outcome: "succeeded", beforeState, afterState, assurance: { method: "owner_step_up" },
      applicationRevision: input.applicationRevision, requestId: command.requestId, occurredAt: at });
  }
  async function createRefund(tx: PawketTransaction, facts: Awaited<ReturnType<typeof order>>, source: "ruling" | "correction", sourceId: string,
    amountVnd: number, requestId: string, at: Date) {
    const paid = await input.payments.paidIntent(tx, facts.id);
    if (!paid || paid.amountVnd !== facts.amountVnd) resolutionFail("dependency_unavailable");
    await input.refunds.createObligation(tx, { orderId: facts.id, paymentIntentId: paid.paymentIntentId, creatorUserId: facts.creatorUserId,
      buyerUserId: facts.buyerUserId, source, sourceId, amountVnd, requestId, at });
  }
  function open(row: typeof commissionDisputes.$inferSelect, at: Date) {
    if (row.state !== "open") resolutionFail("invalid_transition");
    if (at < row.openedAt) resolutionFail("invalid_request");
  }
  return {
    async freezeFulfillment(command: Freeze): Promise<{ closedOrders: number }> {
      enabled(); exact(command, ["creatorUserId", "reason"]);
      if (!commissionIdentifier(command.creatorUserId)) resolutionFail("invalid_request");
      const reason = normalizeResolutionText(command.reason, 1, RESOLUTION_POLICY.noteMaxCodePoints);
      const reference = await kit.ownerMutate(command, "fulfillment_freeze", [command.creatorUserId, reason],
        async () => command.creatorUserId, "owner.commission_fulfillment_freeze", async (tx) => {
          if (!input.standing) resolutionFail("dependency_unavailable");
          if (await input.standing.readCreatorStanding(tx, command.creatorUserId) !== "suspended") resolutionFail("invalid_transition");
          const candidates = await input.orders.listLiveOrders(tx, command.creatorUserId); const at = kit.now();
          for (const candidate of candidates) {
            const facts = await order(tx, candidate.orderId);
            if (facts.creatorUserId !== command.creatorUserId || !["in_progress", "delivered"].includes(facts.state)
              || facts.version !== candidate.version) resolutionFail("version_conflict");
            await closeSuspendedPaidOrder(tx, input, facts, { reason: "fulfillment_frozen", actor: command.owner, requestId: command.requestId, at }, reason);
          }
          const closedOrders = candidates.length;
          await insertOutboxEvent(tx, { eventType: "resolution.fulfillment_frozen.v1", eventVersion: 1, aggregateType: "creator", aggregateId: command.creatorUserId,
            payload: { creatorUserId: command.creatorUserId, closedOrders }, occurredAt: at });
          await audit(tx, command, "owner.commission_fulfillment_freeze", "identity_user", command.creatorUserId,
            { standing: "suspended", liveOrders: closedOrders }, { standing: "suspended", closedOrders, reason }, at);
          return { resultReference: String(closedOrders), at };
        });
      const closedOrders = Number(reference);
      if (!Number.isSafeInteger(closedOrders) || closedOrders < 0 || String(closedOrders) !== reference) resolutionFail("dependency_unavailable");
      return { closedOrders };
    },
    async ruleLateClaim(command: LateClaim): Promise<{ claimId: string }> {
      enabled(); exact(command, ["claimId", "outcome", "reason"], ["amountVnd"]);
      if (!commissionUuid(command.claimId) || !["refund_owed", "rejected"].includes(command.outcome)
        || (command.outcome === "refund_owed" ? !lateClaimAmountValid(command.amountVnd) : Object.hasOwn(command, "amountVnd"))) resolutionFail("invalid_request");
      const reason = normalizeResolutionText(command.reason, 1, RESOLUTION_POLICY.statementMaxCodePoints);
      const reference = await kit.ownerMutate(command, "case_rule_claim", [command.claimId, command.outcome, command.amountVnd ?? null, reason],
        async (tx) => (await order(tx, (await readLatePaymentClaim(tx, command.claimId)).orderId)).creatorUserId, "owner.case_rule_claim", async (tx) => {
          const row = await readLatePaymentClaim(tx, command.claimId, true); const facts = await order(tx, row.orderId); const at = kit.now();
          if (row.state !== "escalated" || !isLatePaymentOrder(facts)) resolutionFail("invalid_transition"); if (at < row.filedAt) resolutionFail("invalid_request");
          const openCase = await input.cases.findOpenCase(tx, { kind: "late_payment", sourceId: row.id }); if (!openCase) resolutionFail("dependency_unavailable");
          const caseRow = await input.cases.readCase(tx, openCase.caseId);
          if (!caseRow || caseRow.state !== "open" || caseRow.kind !== "late_payment" || caseRow.sourceType !== "commission_late_payment_claim"
            || caseRow.sourceId !== row.id || caseRow.orderId !== facts.id) resolutionFail("not_available");
          let obligationId: string | null = null;
          if (command.outcome === "refund_owed") {
            const intent = await input.payments.closedIntent(tx, facts.id); if (!intent) resolutionFail("dependency_unavailable");
            const obligation = await input.refunds.createObligation(tx, { orderId: facts.id, paymentIntentId: intent.paymentIntentId, creatorUserId: facts.creatorUserId,
              buyerUserId: facts.buyerUserId, source: "late_payment", sourceId: row.id, amountVnd: command.amountVnd!, requestId: command.requestId, at }); obligationId = obligation.obligationId;
          }
          await recordLateClaimState(tx, row, command.outcome, command.amountVnd ?? null, at);
          await input.cases.resolveCase(tx, { caseId: caseRow.caseId, resolutionKind: command.outcome, actor: command.owner, reason, requestId: command.requestId, at });
          await audit(tx, command, "owner.case_rule_claim", "commission_late_payment_claim", row.id, { state: row.state, version: row.version, caseId: caseRow.caseId, orderId: facts.id },
            { state: command.outcome, version: row.version + 1, caseId: caseRow.caseId, caseState: "resolved", orderId: facts.id, obligationId, receivedAmountVnd: command.amountVnd ?? null }, at);
          return { resultReference: row.id, at };
        });
      return { claimId: resultId(reference) };
    },
    async rule(command: Rule): Promise<{ rulingId: string }> {
      enabled(); exact(command, ["disputeId", "outcome", "refundAmountVnd", "reasoning"], ["internalNote"]);
      if (!commissionUuid(command.disputeId) || !(RULING_OUTCOMES as readonly unknown[]).includes(command.outcome) || !amountValid(command.refundAmountVnd)) resolutionFail("invalid_request");
      const reasoning = normalizeResolutionText(command.reasoning, 1, RESOLUTION_POLICY.statementMaxCodePoints);
      const internalNote = command.internalNote === undefined ? null : normalizeResolutionText(command.internalNote, 0, RESOLUTION_POLICY.noteMaxCodePoints);
      const reference = await kit.ownerMutate(command, "case_rule", [command.disputeId, command.outcome, command.refundAmountVnd, reasoning, internalNote],
        (tx) => disputeCreator(tx, command.disputeId), "owner.case_rule", async (tx) => {
          const row = await dispute(tx, command.disputeId, true); const facts = await order(tx, row.orderId); const at = kit.now(); open(row, at);
          if (!["in_progress", "delivered"].includes(facts.state) || (command.outcome === "complete" && facts.state !== "delivered")) resolutionFail("invalid_transition");
          if (facts.amountVnd === null || !facts.policyRevisionId) resolutionFail("dependency_unavailable");
          if (command.refundAmountVnd > facts.amountVnd || (command.outcome === "complete" && command.refundAmountVnd >= facts.amountVnd)) resolutionFail("invalid_request");
          const [response] = await tx.select({ id: commissionDisputeStatements.id }).from(commissionDisputeStatements)
            .where(and(eq(commissionDisputeStatements.disputeId, row.id), eq(commissionDisputeStatements.kind, "response"))).limit(1);
          if (!response) {
            const due = await effectiveResolutionDeadline(tx, row.respondBy);
            if (!due) resolutionFail("resolution_disabled"); if (at < due) resolutionFail("invalid_transition");
          }
          const rulingId = randomUUID();
          await tx.insert(commissionRulings).values({ id: rulingId, disputeId: row.id, outcome: command.outcome, refundAmountVnd: command.refundAmountVnd,
            reasoningEnvelope: kit.encrypt("commission_rulings", rulingId, "reasoning", reasoning),
            internalNoteEnvelope: internalNote === null ? null : kit.encrypt("commission_rulings", rulingId, "internal_note", internalNote),
            policyRevisionId: facts.policyRevisionId, ownerUserId: command.owner.userId, actorSessionId: command.owner.sessionId,
            stepUpProofId: command.stepUpProofId, requestId: command.requestId, ruledAt: at });
          const change = { orderId: facts.id, expectedVersion: facts.version, actor: command.owner, requestId: command.requestId, at };
          const changed = command.outcome === "complete" ? await input.orders.completeByResolution(tx, { ...change, kind: "ruling" })
            : await input.orders.closePaidOrder(tx, { ...change, reason: "cancelled_by_ruling" });
          if (command.refundAmountVnd > 0) await createRefund(tx, facts, "ruling", rulingId, command.refundAmountVnd, command.requestId, at);
          const [ruled] = await tx.update(commissionDisputes).set({ state: "ruled", closedAt: at, version: row.version + 1 })
            .where(and(eq(commissionDisputes.id, row.id), eq(commissionDisputes.version, row.version), eq(commissionDisputes.state, "open"))).returning();
          if (!ruled) resolutionFail("version_conflict");
          const caseRow = await openDisputeCase(tx, row.id);
          await input.cases.resolveCase(tx, { caseId: caseRow.caseId, resolutionKind: "ruled", actor: command.owner, reason: "owner_ruling", requestId: command.requestId, at });
          // A ruling supersedes pending proposals without restoring the ended order's review clock.
          const pending = await tx.select().from(commissionProposals).where(and(eq(commissionProposals.orderId, facts.id), eq(commissionProposals.state, "pending"))).for("update");
          for (const proposal of pending) {
            const [ended] = await tx.update(commissionProposals).set({ state: "superseded", endedAt: at, endedByUserId: command.owner.userId, version: proposal.version + 1 })
              .where(and(eq(commissionProposals.id, proposal.id), eq(commissionProposals.version, proposal.version), eq(commissionProposals.state, "pending"))).returning();
            if (!ended) resolutionFail("version_conflict");
            await insertOutboxEvent(tx, { eventType: "resolution.proposal_ended.v1", eventVersion: 1, aggregateType: "commission_proposal", aggregateId: proposal.id,
              payload: { proposalId: proposal.id, orderId: facts.id, state: "superseded" }, occurredAt: at });
          }
          await insertOutboxEvent(tx, { eventType: "resolution.dispute_closed.v1", eventVersion: 1, aggregateType: "commission_dispute", aggregateId: row.id,
            payload: { disputeId: row.id, orderId: facts.id, state: "ruled" }, occurredAt: at });
          await insertOutboxEvent(tx, { eventType: "resolution.ruling_recorded.v1", eventVersion: 1, aggregateType: "commission_ruling", aggregateId: rulingId,
            payload: { rulingId, disputeId: row.id, orderId: facts.id, outcome: command.outcome }, occurredAt: at });
          await audit(tx, command, "owner.case_rule", "commission_dispute", row.id, { state: row.state, orderId: facts.id, orderState: facts.state, orderVersion: facts.version },
            { state: "ruled", orderId: facts.id, orderState: command.outcome === "complete" ? "completed" : "closed", orderVersion: changed.version, rulingId, refundAmountVnd: command.refundAmountVnd }, at);
          return { resultReference: rulingId, at };
        });
      return { rulingId: resultId(reference) };
    },
    async correctRuling(command: Correct): Promise<{ correctionId: string; effect: CorrectionEffect }> {
      enabled(); exact(command, ["rulingId", "newRefundAmountVnd", "reason"]);
      if (!commissionUuid(command.rulingId) || !amountValid(command.newRefundAmountVnd)) resolutionFail("invalid_request");
      const reason = normalizeResolutionText(command.reason, 1, RESOLUTION_POLICY.statementMaxCodePoints);
      const reference = await kit.ownerMutate(command, "case_correct", [command.rulingId, command.newRefundAmountVnd, reason],
        (tx) => rulingCreator(tx, command.rulingId), "owner.case_correct", async (tx) => {
          const row = await ruling(tx, command.rulingId); const facts = await order(tx, (await dispute(tx, row.disputeId)).orderId); const at = kit.now();
          if (at < row.ruledAt) resolutionFail("invalid_request");
          const deadline = await effectiveResolutionDeadline(tx, new Date(row.ruledAt.getTime() + RESOLUTION_POLICY.correctionWindowMs));
          if (!deadline) resolutionFail("resolution_disabled");
          const guardUntil = new Date(deadline.getTime() + 1);
          if (at >= guardUntil) resolutionFail("deadline_passed");
          if (facts.amountVnd === null) resolutionFail("dependency_unavailable");
          if (command.newRefundAmountVnd > facts.amountVnd || (row.outcome === "complete" && command.newRefundAmountVnd >= facts.amountVnd)) resolutionFail("invalid_request");
          const corrections = await tx.select({ id: commissionRulingCorrections.id }).from(commissionRulingCorrections).where(eq(commissionRulingCorrections.rulingId, row.id));
          const correctionIds = new Set(corrections.map((entry) => entry.id));
          const obligations = (await input.refunds.listForOrder(tx, { orderId: facts.id })).filter((entry) => (entry.state !== "waived" || entry.hasRecordedSend)
            && ((entry.source === "ruling" && entry.sourceId === row.id) || (entry.source === "correction" && correctionIds.has(entry.sourceId))));
          // Include recorded sends in the total: a correction never creates a second debt for money already sent.
          const currentAmount = obligations.reduce((total, entry) => total + entry.amountVnd, 0); const correctionId = randomUUID();
          // Unchanged totals use reduced; recorded_only is reserved for a target below fixed money.
          let effect: CorrectionEffect = "reduced";
          if (command.newRefundAmountVnd > currentAmount) {
            await createRefund(tx, facts, "correction", correctionId, command.newRefundAmountVnd - currentAmount, command.requestId, at); effect = "increased";
          } else if (command.newRefundAmountVnd < currentAmount) {
            const adjustable = obligations.filter((entry) => ["awaiting_destination", "awaiting_send"].includes(entry.state) && !entry.hasRecordedSend);
            const adjustableTotal = adjustable.reduce((total, entry) => total + entry.amountVnd, 0); const fixedTotal = currentAmount - adjustableTotal;
            const adjustableTarget = Math.max(0, command.newRefundAmountVnd - fixedTotal); let remaining = adjustableTotal - adjustableTarget;
            for (const entry of [...adjustable].reverse()) {
              if (remaining === 0) break;
              const reduction = Math.min(remaining, entry.amountVnd);
              const result = await input.refunds.adjustAmount(tx, { obligationId: entry.obligationId, newAmountVnd: entry.amountVnd - reduction,
                actor: command.owner, requestId: command.requestId, at });
              // The creator fence keeps sends stable; never count a protected amount as reduced.
              if (result === "recorded_only") resolutionFail("version_conflict"); remaining -= reduction;
              if (result === "waived") {
                const overdue = await input.cases.findOpenCase(tx, { kind: "refund_overdue", sourceId: entry.obligationId });
                if (overdue) await input.cases.resolveCase(tx, { caseId: overdue.caseId, resolutionKind: "waived", actor: command.owner,
                  reason: null, requestId: command.requestId, at });
              }
            }
            // Reduction effects: below fixedTotal, recorded_only wins even when all adjustable obligations are waived.
            // At fixedTotal all adjustable obligations are waived; above it the effect is reduced.
            effect = command.newRefundAmountVnd < fixedTotal ? "recorded_only" : adjustableTarget === 0 ? "waived" : "reduced";
          }
          await tx.insert(commissionRulingCorrections).values({ id: correctionId, rulingId: row.id, refundAmountVnd: command.newRefundAmountVnd,
            reasonEnvelope: kit.encrypt("commission_ruling_corrections", correctionId, "reason", reason), effect, ownerUserId: command.owner.userId,
            actorSessionId: command.owner.sessionId, stepUpProofId: command.stepUpProofId, requestId: command.requestId, correctedAt: at });
          await insertOutboxEvent(tx, { eventType: "resolution.ruling_corrected.v1", eventVersion: 1, aggregateType: "commission_ruling_correction", aggregateId: correctionId,
            payload: { correctionId, rulingId: row.id, effect }, occurredAt: at });
          await audit(tx, command, "owner.case_correct", "commission_ruling", row.id, { refundAmountVnd: currentAmount },
            { refundAmountVnd: command.newRefundAmountVnd, correctionId, effect }, at);
          return { resultReference: `${correctionId}:${effect}`, at, guardUntil };
        });
      const parts = reference.split(":"); if (parts.length !== 2 || !(effects as readonly string[]).includes(parts[1]!)) resolutionFail("dependency_unavailable");
      return { correctionId: resultId(parts[0]!), effect: parts[1] as CorrectionEffect };
    },
    async postQuestion(command: Target & Readonly<{ text: string }>): Promise<{ statementId: string }> {
      enabled(); exact(command, ["disputeId", "text"]); if (!commissionUuid(command.disputeId)) resolutionFail("invalid_request");
      const text = normalizeResolutionText(command.text, 1, RESOLUTION_POLICY.statementMaxCodePoints);
      const reference = await kit.ownerMutate(command, "case_question", [command.disputeId, text], (tx) => disputeCreator(tx, command.disputeId), "owner.case_question", async (tx) => {
        const row = await dispute(tx, command.disputeId, true); const at = kit.now(); open(row, at); const statementId = randomUUID();
        await tx.insert(commissionDisputeStatements).values({ id: statementId, disputeId: row.id, authorUserId: command.owner.userId, authorRole: "owner", kind: "question",
          textEnvelope: kit.encrypt("commission_dispute_statements", statementId, "text", text), actorSessionId: command.owner.sessionId, requestId: command.requestId, createdAt: at });
        const caseRow = await openDisputeCase(tx, row.id);
        await input.cases.recordCaseEvent(tx, { caseId: caseRow.caseId, action: "question_posted", actor: command.owner, reason: "owner_question", requestId: command.requestId, at });
        await insertOutboxEvent(tx, { eventType: "resolution.dispute_statement_added.v1", eventVersion: 1, aggregateType: "commission_dispute", aggregateId: row.id,
          payload: { disputeId: row.id, statementId, authorRole: "owner" }, occurredAt: at });
        await audit(tx, command, "owner.case_question", "commission_dispute", row.id, { state: row.state, caseVersion: caseRow.version },
          { state: row.state, caseVersion: caseRow.version + 1, statementId }, at);
        return { resultReference: statementId, at };
      });
      return { statementId: resultId(reference) };
    },
    async extendDispute(command: Target & Readonly<{ until: Date; reason: string }>): Promise<{ disputeId: string }> {
      enabled(); exact(command, ["disputeId", "until", "reason"]); if (!commissionUuid(command.disputeId)) resolutionFail("invalid_request"); commissionTime(command.until);
      const reason = normalizeResolutionText(command.reason, 1, RESOLUTION_POLICY.noteMaxCodePoints);
      const reference = await kit.ownerMutate(command, "case_extend", [command.disputeId, command.until.toISOString(), reason], (tx) => disputeCreator(tx, command.disputeId), "owner.case_extend", async (tx) => {
        const row = await dispute(tx, command.disputeId, true); const at = kit.now(); open(row, at);
        if (command.until <= at || command.until <= row.respondBy || command.until.getTime() > row.openedAt.getTime() + RESOLUTION_POLICY.maxDisputeExtensionMs) resolutionFail("invalid_request");
        const [extended] = await tx.update(commissionDisputes).set({ respondBy: command.until, version: row.version + 1 })
          .where(and(eq(commissionDisputes.id, row.id), eq(commissionDisputes.version, row.version), eq(commissionDisputes.state, "open"))).returning();
        if (!extended) resolutionFail("version_conflict");
        const caseRow = await openDisputeCase(tx, row.id);
        await input.cases.recordCaseEvent(tx, { caseId: caseRow.caseId, action: "deadline_extended", actor: command.owner, reason, requestId: command.requestId, at });
        await audit(tx, command, "owner.case_extend", "commission_dispute", row.id, { state: row.state, respondBy: row.respondBy.toISOString(), version: row.version },
          { state: row.state, respondBy: command.until.toISOString(), version: extended.version }, at);
        return { resultReference: row.id, at, guardUntil: command.until };
      });
      return { disputeId: resultId(reference) };
    },
    async resolveRefundCase(command: Refund): Promise<{ caseId: string }> {
      enabled(); exact(command, ["caseId", "action", "reason"], ["until"]);
      if (!commissionUuid(command.caseId) || !["accept_evidence", "require_resend", "waive", "extend_deadline"].includes(command.action)
        || (command.action === "extend_deadline") !== (command.until !== undefined)) resolutionFail("invalid_request");
      if (command.until !== undefined) commissionTime(command.until);
      const reason = normalizeResolutionText(command.reason, 1, RESOLUTION_POLICY.noteMaxCodePoints);
      const actionClass = `owner.case_${command.action}`;
      const reference = await kit.ownerMutate(command, `case_${command.action}`, [command.caseId, command.action, command.until?.toISOString() ?? null, reason],
        async (tx) => (await order(tx, (await refundCase(tx, command.caseId)).orderId)).creatorUserId, actionClass, async (tx) => {
          const row = await refundCase(tx, command.caseId); const at = kit.now();
          if (row.state !== "open") resolutionFail("invalid_transition");
          const obligations = await input.refunds.listForOrder(tx, { orderId: row.orderId });
          const obligation = obligations.find((entry) => entry.obligationId === row.sourceId); if (!obligation) resolutionFail("not_available");
          const change = { obligationId: obligation.obligationId, actor: command.owner, requestId: command.requestId, at };
          let resolutionKind: string;
          if (command.action === "accept_evidence") { await input.refunds.acceptReceiptEvidence(tx, change); resolutionKind = "receipt_accepted"; }
          else if (command.action === "require_resend") { await input.refunds.requireResend(tx, change); resolutionKind = "resend_required"; }
          else if (command.action === "waive") { await input.refunds.waive(tx, change); resolutionKind = "waived"; }
          else {
            if (!command.until || command.until <= at || command.until.getTime() > at.getTime() + RESOLUTION_POLICY.maxRefundExtensionMs) resolutionFail("invalid_request");
            await input.refunds.extendDeadline(tx, { ...change, until: command.until }); resolutionKind = "extended";
          }
          await input.cases.resolveCase(tx, { caseId: row.caseId, resolutionKind, actor: command.owner, reason, requestId: command.requestId, at });
          const [after] = (await input.refunds.listForOrder(tx, { orderId: row.orderId })).filter((entry) => entry.obligationId === obligation.obligationId);
          if (!after) resolutionFail("dependency_unavailable");
          await audit(tx, command, actionClass, "trust_case", row.caseId, { state: row.state, obligationId: obligation.obligationId, obligationState: obligation.state, dueAt: obligation.dueAt?.toISOString() ?? null },
            { state: "resolved", resolutionKind, obligationId: obligation.obligationId, obligationState: after.state, dueAt: after.dueAt?.toISOString() ?? null }, at);
          return { resultReference: row.caseId, at, ...(command.until ? { guardUntil: command.until } : {}) };
        });
      return { caseId: resultId(reference) };
    },
  };
}
export type OwnerResolutionService = ReturnType<typeof createOwnerResolutionService>;
