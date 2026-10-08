import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { commissionLatePaymentClaims, commissionProposals, commissionResolutionPauses, type PawketDatabase } from "@pawket/database";
import { commissionInteger, commissionTime, commissionUuid } from "@pawket/orders";
import { effectiveResolutionDeadline } from "./deadlines.js";
import { resolutionFail } from "./contracts.js";
import { createProposalEnder, isProposalStale } from "./proposal-service.js";
import { createLateClaimEscalator } from "./late-claim-service.js";
import type { ResolutionOrderPort, ResolutionRefundPort, ResolutionCasePort, ResolutionPaymentFactsPort, ResolutionRefundMaintenancePort, RefundCandidateCursor } from "./ports.js";

type Input = Readonly<{ db: PawketDatabase; refunds: ResolutionRefundPort & ResolutionRefundMaintenancePort; orders: ResolutionOrderPort;
  cases: ResolutionCasePort; payments: ResolutionPaymentFactsPort; idFactory?(): string; now?(): Date }>;
export type ResolutionScanResult = Readonly<{ expiredProposals: number; lapsedProposals: number; escalatedClaims: number;
  overdueCases: number; presumedReceived: number; purgedDestinations: number }>;

export function createResolutionMaintenance(input: Input) {
  const now = () => { const at = (input.now ?? (() => new Date()))(); commissionTime(at); return new Date(at); };
  const newId = () => { const id = (input.idFactory ?? randomUUID)(); if (!commissionUuid(id)) resolutionFail("dependency_unavailable"); return id; };
  const proposals = createProposalEnder(input); const claims = createLateClaimEscalator({ ...input, mode: "enabled" });
  let proposalAfter: { createdAt: Date; id: string } | null = null;
  let claimAfter: { creatorRespondBy: Date; id: string } | null = null;
  let overdueAfter: RefundCandidateCursor | null = null; let confirmationAfter: RefundCandidateCursor | null = null;
  return {
    async readRefundOverdueCount(): Promise<number> {
      const at = now();
      return input.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended('commissions:resolution-pauses', 0))`);
        const [pause] = await tx.select({ id: commissionResolutionPauses.id }).from(commissionResolutionPauses).where(isNull(commissionResolutionPauses.endedAt)).limit(1);
        if (pause) return 0;
        let count = 0; let after: RefundCandidateCursor | null = null;
        for (;;) {
          const rows = await input.refunds.readOverdueCandidates(input.db, { at, limit: 500, after });
          for (const row of rows) { if (!row.dueAt) continue; const deadline = await effectiveResolutionDeadline(tx, row.dueAt); if (deadline && deadline <= at) count++; }
          const last = rows.at(-1); if (rows.length < 500 || !last?.dueAt) return count;
          after = { deadline: last.dueAt, obligationId: last.obligationId };
        }
      });
    },
    async observeResolutionMode(mode: "disabled" | "enabled"): Promise<{ change: "opened" | "closed" | "none"; paused: boolean }> {
      if (mode !== "disabled" && mode !== "enabled") resolutionFail("invalid_request");
      return input.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('commissions:resolution-pauses', 0))`);
        const [pause] = await tx.select().from(commissionResolutionPauses).where(isNull(commissionResolutionPauses.endedAt)).limit(1);
        if (mode === "disabled" && !pause) {
          await tx.insert(commissionResolutionPauses).values({ id: newId(), startedAt: now() }); return { change: "opened", paused: true };
        }
        if (mode === "enabled" && pause) {
          await tx.update(commissionResolutionPauses).set({ endedAt: now(), version: pause.version + 1 }).where(eq(commissionResolutionPauses.id, pause.id));
          return { change: "closed", paused: false };
        }
        return { change: "none", paused: !!pause };
      });
    },
    async scan(command: Readonly<{ limit: number }>): Promise<ResolutionScanResult> {
      const limit = commissionInteger(command.limit, 1, 500); const at = now();
      const result = { expiredProposals: 0, lapsedProposals: 0, escalatedClaims: 0, overdueCases: 0, presumedReceived: 0, purgedDestinations: 0 };
      // Keep mode observation from opening a pause between eligibility and a transition,
      // including Payments' retention writer, which owns its own transaction.
      return input.db.transaction(async (pauseTx) => {
        await pauseTx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended('commissions:resolution-pauses', 0))`);
        const [pause] = await pauseTx.select({ id: commissionResolutionPauses.id }).from(commissionResolutionPauses).where(isNull(commissionResolutionPauses.endedAt)).limit(1);
        if (pause) return result;
        const pending = await input.db.select().from(commissionProposals).where(and(eq(commissionProposals.state, "pending"), proposalAfter ?
          or(gt(commissionProposals.createdAt, proposalAfter.createdAt), and(eq(commissionProposals.createdAt, proposalAfter.createdAt), gt(commissionProposals.id, proposalAfter.id))) : undefined))
          .orderBy(asc(commissionProposals.createdAt), asc(commissionProposals.id)).limit(limit);
        for (const candidate of pending) await input.db.transaction(async (tx) => {
          const order = await input.orders.lockOrder(tx, candidate.orderId); if (!order) return;
          const at = now();
          const [row] = await tx.select().from(commissionProposals).where(and(eq(commissionProposals.id, candidate.id), eq(commissionProposals.state, "pending"))).limit(1).for("update", { skipLocked: true });
          if (!row) return;
          const stale = isProposalStale(row, order); const deadline = await effectiveResolutionDeadline(tx, row.respondBy);
          if (!stale && (!deadline || at < deadline)) return;
          await proposals.endProposalWithoutAgreement(tx, row, stale ? "lapsed" : "expired", at, null, `resolution-scan:${newId()}`);
          if (stale) result.lapsedProposals++; else result.expiredProposals++;
        });
        const lastProposal = pending.at(-1); proposalAfter = pending.length === limit && lastProposal ? { createdAt: lastProposal.createdAt, id: lastProposal.id } : null;
        const unanswered = await input.db.select().from(commissionLatePaymentClaims).where(and(eq(commissionLatePaymentClaims.state, "awaiting_creator"), claimAfter ?
          or(gt(commissionLatePaymentClaims.creatorRespondBy, claimAfter.creatorRespondBy), and(eq(commissionLatePaymentClaims.creatorRespondBy, claimAfter.creatorRespondBy), gt(commissionLatePaymentClaims.id, claimAfter.id))) : undefined))
          .orderBy(asc(commissionLatePaymentClaims.creatorRespondBy), asc(commissionLatePaymentClaims.id)).limit(limit);
        for (const candidate of unanswered) await input.db.transaction(async (tx) => {
          await input.orders.lockOrder(tx, candidate.orderId);
          const at = now();
          const [row] = await tx.select().from(commissionLatePaymentClaims).where(and(eq(commissionLatePaymentClaims.id, candidate.id), eq(commissionLatePaymentClaims.state, "awaiting_creator"))).limit(1).for("update", { skipLocked: true });
          if (!row) return; const deadline = await effectiveResolutionDeadline(tx, row.creatorRespondBy); if (!deadline || at < deadline) return;
          await claims.escalateUnanswered(tx, row, at, `resolution-scan:${newId()}`); result.escalatedClaims++;
        });
        const lastClaim = unanswered.at(-1); claimAfter = unanswered.length === limit && lastClaim ? { creatorRespondBy: lastClaim.creatorRespondBy, id: lastClaim.id } : null;
        const overdue = await input.refunds.readOverdueCandidates(input.db, { at, limit, after: overdueAfter });
        for (const candidate of overdue) await input.db.transaction(async (tx) => {
          const order = await input.orders.lockOrder(tx, candidate.orderId); if (!order) return;
          const at = now();
          // A send or corrected destination may have committed since candidate discovery.
          const row = (await input.refunds.listForOrder(tx, { orderId: order.id })).find((row) => row.obligationId === candidate.obligationId);
          if (!row || row.state !== "awaiting_send" || row.version !== candidate.version || !row.dueAt) return;
          const deadline = await effectiveResolutionDeadline(tx, row.dueAt); if (!deadline || at < deadline) return;
          const opened = await input.cases.openCase(tx, { kind: "refund_overdue", orderId: order.id, sourceType: "commission_refund_obligation",
            sourceId: row.obligationId, policyRevisionId: order.policyRevisionId, requestId: `resolution-scan:${newId()}`, at });
          if (opened.created) result.overdueCases++;
        });
        const lastOverdue = overdue.at(-1); overdueAfter = overdue.length === limit && lastOverdue?.dueAt ? { deadline: lastOverdue.dueAt, obligationId: lastOverdue.obligationId } : null;
        const confirmations = await input.refunds.readConfirmationCandidates(input.db, { at, limit, after: confirmationAfter });
        for (const candidate of confirmations) await input.db.transaction(async (tx) => {
          const order = await input.orders.lockOrder(tx, candidate.orderId); if (!order) return;
          const at = now();
          const row = (await input.refunds.listForOrder(tx, { orderId: order.id })).find((row) => row.obligationId === candidate.obligationId);
          if (!row || row.state !== "sent" || row.version !== candidate.version || !row.confirmBy) return;
          const deadline = await effectiveResolutionDeadline(tx, row.confirmBy); if (!deadline || at < deadline) return;
          await input.refunds.presumeReceived(tx, { obligationId: row.obligationId, at, requestId: `resolution-scan:${newId()}` }); result.presumedReceived++;
        });
        const lastConfirmation = confirmations.at(-1); confirmationAfter = confirmations.length === limit && lastConfirmation?.confirmBy ? { deadline: lastConfirmation.confirmBy, obligationId: lastConfirmation.obligationId } : null;
        // R19: terminal destination retention is exempt from party pause grace.
        result.purgedDestinations = await input.refunds.purgeDestinations(input.db, { at, limit }); return result;
      });
    },
  };
}
