import { and, eq } from "drizzle-orm";
import { commissionBriefs, commissionOrders, type PawketTransaction } from "@pawket/database";
import { commissionUuid } from "./policy.js";
import { lockCommissionCreator } from "./payment-lifecycle.js";

/** Structural trust port, without importing Trust. Brief IDs are their order IDs. */
export function createBriefReportTargetPort() {
  return {
    async resolve(tx: PawketTransaction, target: { kind: string; orderId?: string }, reporter: { userId: string } | null) {
      if (target.kind !== "commission_brief" || !commissionUuid(target.orderId) || !reporter) return null;
      const [order] = await tx.select({ creatorUserId: commissionOrders.creatorUserId, buyerUserId: commissionOrders.buyerUserId })
        .from(commissionOrders).innerJoin(commissionBriefs, eq(commissionBriefs.orderId, commissionOrders.id))
        .where(and(eq(commissionOrders.id, target.orderId), eq(commissionOrders.creatorUserId, reporter.userId))).limit(1);
      if (!order || order.buyerUserId === reporter.userId) return null;
      await lockCommissionCreator(tx, order.creatorUserId);
      return { kind: "commission_brief" as const, targetId: target.orderId, orderId: target.orderId, contentOwnerUserId: order.buyerUserId, packageRevisionId: null };
    },
  };
}
