import type { PawketTransaction } from "@pawket/database";
import type { CommissionIntakeFencePort } from "@pawket/orders";
import { ResolutionError, resolutionFail } from "./contracts.js";
import { effectiveResolutionDeadline } from "./deadlines.js";
import type { ResolutionRefundPort } from "./ports.js";

/** Catalog owns the creator lock and commit-time check; this port shares that transaction. */
export function createCommissionIntakeFencePort(input: { mode: "disabled" | "enabled"; refunds: Pick<ResolutionRefundPort, "awaitingSendDeadlines"> }): CommissionIntakeFencePort {
  if (input.mode !== "disabled" && input.mode !== "enabled") resolutionFail("invalid_request");
  async function describe(tx: PawketTransaction, creatorUserId: string, at: Date) {
    if (input.mode === "disabled") return { paused: false, overdue: [] };
    if (!(at instanceof Date) || !Number.isFinite(at.getTime())) resolutionFail("invalid_request");
    try {
      const overdue: { obligationId: string; dueAt: string }[] = [];
      for (const row of await input.refunds.awaitingSendDeadlines(tx, creatorUserId)) {
        const deadline = await effectiveResolutionDeadline(tx, row.dueAt);
        if (deadline && deadline <= at) overdue.push({ obligationId: row.obligationId, dueAt: deadline.toISOString() });
      }
      return { paused: overdue.length > 0, overdue };
    } catch (error) { if (error instanceof ResolutionError) throw error; return resolutionFail("dependency_unavailable"); }
  }
  return { describe, isIntakePaused: async (tx, creatorUserId, at) => (await describe(tx, creatorUserId, at)).paused };
}
