import { and, asc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { commissionFulfillmentPauses, commissionOrders, type PawketDatabase } from "@pawket/database";
import { commissionFail } from "./contracts.js";
import { readCommissionCompletionDueAt } from "./fulfillment-service.js";
import { lockCommissionCreator } from "./payment-lifecycle.js";
import { commissionInteger, commissionTime, commissionUuid } from "./policy.js";
import { noCommissionCompletionHolds, type CommissionCompletionHoldPort } from "./ports.js";
import type { createCommissionOrderPersistence } from "./order-persistence.js";

type CompletionCursor = Readonly<{ reviewEndsAt: Date; id: string }>;
type CompletionResult = Readonly<{ scanned: number; completed: number; held: number; waiting: number; nextAfter: CompletionCursor | null }>;
type Kit = Readonly<{
  boundary<T>(run: () => Promise<T>): Promise<T>; now(): Date; newId(): string;
  completeCommissionOrder: ReturnType<typeof createCommissionOrderPersistence>["completeCommissionOrder"];
}>;

export function createCommissionFulfillmentMaintenance(kit: Kit, input: Readonly<{ db: PawketDatabase; holds?: CommissionCompletionHoldPort }>) {
  const holds = input.holds ?? noCommissionCompletionHolds;
  return {
    async observeFulfillmentMode(mode: "disabled" | "enabled"): Promise<Readonly<{ change: "opened" | "closed" | "none"; paused: boolean }>> {
      if (mode !== "disabled" && mode !== "enabled") commissionFail("invalid_request");
      return kit.boundary(() => input.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('commissions:fulfillment-pauses', 0))`);
        const [pause] = await tx.select().from(commissionFulfillmentPauses).where(isNull(commissionFulfillmentPauses.endedAt)).limit(1);
        if (mode === "disabled" && !pause) {
          await tx.insert(commissionFulfillmentPauses).values({ id: kit.newId(), startedAt: kit.now() });
          return { change: "opened", paused: true };
        }
        if (mode === "enabled" && pause) {
          await tx.update(commissionFulfillmentPauses).set({ endedAt: kit.now() }).where(eq(commissionFulfillmentPauses.id, pause.id));
          return { change: "closed", paused: false };
        }
        return { change: "none", paused: !!pause };
      }));
    },
    async completeDue(command: Readonly<{ limit?: number; after?: CompletionCursor | null }> = {}): Promise<CompletionResult> {
      const limit = commissionInteger(command.limit ?? 100, 1, 500);
      const after = command.after;
      if (after != null) { commissionTime(after.reviewEndsAt); if (!commissionUuid(after.id)) commissionFail("invalid_request"); }
      return kit.boundary(async () => {
        const candidates = await input.db.select({ id: commissionOrders.id, creatorUserId: commissionOrders.creatorUserId, reviewEndsAt: commissionOrders.reviewEndsAt })
          .from(commissionOrders).where(and(eq(commissionOrders.state, "delivered"), lte(commissionOrders.reviewEndsAt, kit.now()),
            after ? or(gt(commissionOrders.reviewEndsAt, after.reviewEndsAt), and(eq(commissionOrders.reviewEndsAt, after.reviewEndsAt), gt(commissionOrders.id, after.id))) : undefined))
          .orderBy(asc(commissionOrders.reviewEndsAt), asc(commissionOrders.id)).limit(limit);
        let completed = 0; let held = 0; let waiting = 0;
        for (const candidate of candidates) {
          const outcome = await input.db.transaction(async (tx) => {
            await lockCommissionCreator(tx, candidate.creatorUserId);
            const [order] = await tx.select().from(commissionOrders).where(eq(commissionOrders.id, candidate.id)).limit(1);
            if (!order || order.state !== "delivered" || !order.reviewEndsAt) return "changed";
            const due = await readCommissionCompletionDueAt(tx, order.reviewEndsAt); const at = kit.now();
            if (due === null || due > at) return "waiting";
            if (await holds.hasActiveCompletionHold(tx, order.id)) return "held";
            await kit.completeCommissionOrder(tx, order, "review_window_elapsed", null, `commission-completion:${kit.newId()}`, at);
            return "completed";
          });
          if (outcome === "completed") completed++;
          else if (outcome === "held") held++;
          else if (outcome === "waiting") waiting++;
        }
        const last = candidates.at(-1);
        return { scanned: candidates.length, completed, held, waiting,
          nextAfter: candidates.length === limit && last ? { reviewEndsAt: last.reviewEndsAt!, id: last.id } : null };
      });
    },
  };
}
