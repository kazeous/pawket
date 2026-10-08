import { and, eq } from "drizzle-orm";
import { commissionDisputes, commissionProposals, type PawketTransaction } from "@pawket/database";
import type { CommissionCompletionHoldPort } from "@pawket/orders";

/** Orders calls this inside its completing transaction, after taking the creator fence. */
export function createResolutionHoldPort(): CommissionCompletionHoldPort {
  async function hasOpenDispute(tx: PawketTransaction, orderId: string): Promise<boolean> {
    const [row] = await tx.select({ id: commissionDisputes.id }).from(commissionDisputes)
      .where(and(eq(commissionDisputes.orderId, orderId), eq(commissionDisputes.state, "open"))).limit(1);
    return !!row;
  }
  return {
    hasOpenDispute,
    async hasActiveCompletionHold(tx: PawketTransaction, orderId: string): Promise<boolean> {
      if (await hasOpenDispute(tx, orderId)) return true;
      const [row] = await tx.select({ id: commissionProposals.id }).from(commissionProposals)
        .where(and(eq(commissionProposals.orderId, orderId), eq(commissionProposals.state, "pending"), eq(commissionProposals.orderStateAtCreation, "delivered"))).limit(1);
      return !!row;
    },
  };
}
