import { paymentIntents, type PawketTransaction } from "@pawket/database";
import { and, eq, inArray } from "drizzle-orm";

/** Internal facts only. Callers authorize and lock the order in their domain transaction. */
export function createCommissionPaymentFactsPort() {
  async function read(tx: PawketTransaction, orderId: string, states: readonly string[]): Promise<{ paymentIntentId: string; amountVnd: number } | null> {
    const [row] = await tx.select({ paymentIntentId: paymentIntents.id, amountVnd: paymentIntents.amountVnd }).from(paymentIntents)
      .where(and(eq(paymentIntents.purpose, "commission"), eq(paymentIntents.commissionOrderId, orderId), inArray(paymentIntents.state, [...states]))).limit(1);
    return row ?? null;
  }
  return {
    paidIntent: (tx: PawketTransaction, orderId: string) => read(tx, orderId, ["confirmed"]),
    closedIntent: (tx: PawketTransaction, orderId: string) => read(tx, orderId, ["expired", "rejected"]),
  };
}
export type CommissionPaymentFactsPort = ReturnType<typeof createCommissionPaymentFactsPort>;
