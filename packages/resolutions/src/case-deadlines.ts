import { eq } from "drizzle-orm";
import { commissionDisputes, commissionRulings, type PawketDatabase, type PawketTransaction } from "@pawket/database";
import type { ResolutionRefundView } from "./ports.js";
import { effectiveResolutionDeadline } from "./deadlines.js";
import { RESOLUTION_POLICY } from "./policy.js";

type CaseRow = Readonly<{ caseId: string; kind: string; state: string; sourceId: string; orderId: string }>;
// Structural port: Trust receives timestamps only; no evidence read or access log.
export function createResolutionCaseDeadlinePort(input: Readonly<{ refunds: Readonly<{
  listForOrder(tx: PawketTransaction, command: { orderId: string }): Promise<readonly Pick<ResolutionRefundView, "obligationId" | "dueAt">[]>;
}> }>) {
  return {
    async nextDeadlines(db: PawketDatabase, rows: readonly CaseRow[]): Promise<ReadonlyMap<string, Date | null>> {
      return db.transaction(async (tx) => {
        const result = new Map<string, Date | null>();
        const refundsByOrder = new Map<string, Awaited<ReturnType<typeof input.refunds.listForOrder>>>();
        for (const row of rows) {
          let deadline: Date | null = null;
          if (row.state === "open" && row.kind === "dispute") {
            const [dispute] = await tx.select({ state: commissionDisputes.state, respondBy: commissionDisputes.respondBy })
              .from(commissionDisputes).where(eq(commissionDisputes.id, row.sourceId)).limit(1);
            if (dispute?.state === "open") deadline = dispute.respondBy;
          } else if (row.state === "open" && row.kind === "refund_overdue") {
            if (!refundsByOrder.has(row.orderId)) refundsByOrder.set(row.orderId, await input.refunds.listForOrder(tx, { orderId: row.orderId }));
            deadline = refundsByOrder.get(row.orderId)?.find((refund) => refund.obligationId === row.sourceId)?.dueAt ?? null;
          }
          result.set(row.caseId, deadline === null ? null : await effectiveResolutionDeadline(tx, deadline));
        }
        return result;
      });
    },
  };
}
export function createResolutionCaseMetadataPort() {
  return {
    async readForCase(db: PawketDatabase, row: CaseRow) {
      const empty = { disputeOpenedAt: null, respondBy: null, ruling: null };
      if (row.kind !== "dispute") return empty;
      return db.transaction(async (tx: PawketTransaction) => {
        const [dispute] = await tx.select({ openedAt: commissionDisputes.openedAt, respondBy: commissionDisputes.respondBy })
          .from(commissionDisputes).where(eq(commissionDisputes.id, row.sourceId)).limit(1);
        if (!dispute) return empty;
        const [ruling] = await tx.select({ id: commissionRulings.id, outcome: commissionRulings.outcome, refundAmountVnd: commissionRulings.refundAmountVnd, ruledAt: commissionRulings.ruledAt })
          .from(commissionRulings).where(eq(commissionRulings.disputeId, row.sourceId)).limit(1);
        return { disputeOpenedAt: dispute.openedAt.toISOString(), respondBy: dispute.respondBy.toISOString(),
          ruling: ruling ? { ...ruling, ruledAt: ruling.ruledAt.toISOString(),
            correctionEndsAt: (await effectiveResolutionDeadline(tx, new Date(ruling.ruledAt.getTime() + RESOLUTION_POLICY.correctionWindowMs)))?.toISOString() ?? null } : null };
      });
    },
  };
}
