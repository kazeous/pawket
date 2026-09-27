import type { PawketTransaction } from "@pawket/database";

/** Database and application boundaries both require exactly one product owner. */
export type PaymentPurpose = Readonly<{ kind: "tip"; tipId: string }> | Readonly<{ kind: "commission"; orderId: string }>;
type Binding = Readonly<{ purpose: string; tipId: string | null; commissionOrderId: string | null }>;
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
export function isTipPayment<T extends Binding>(row: T): row is T & { purpose: "tip"; tipId: string; commissionOrderId: null } {
  return row.purpose === "tip" && uuid(row.tipId) && row.commissionOrderId === null;
}
export function readPaymentPurpose(row: Binding): PaymentPurpose | null {
  if (isTipPayment(row)) return Object.freeze({ kind: "tip", tipId: row.tipId });
  if (row.purpose === "commission" && row.tipId === null && uuid(row.commissionOrderId)) return Object.freeze({ kind: "commission", orderId: row.commissionOrderId });
  return null;
}

export type CommissionSettlementCommand = Readonly<{
  orderId: string; creatorUserId: string; paymentIntentId: string; amountVnd: number; at: Date;
  actor: Readonly<{ userId: string; sessionId: string }> | null; requestId: string;
}>;
/** Orders owns fulfillment. Payments owns money and calls this within its transaction. */
export type CommissionPaymentLifecyclePort = Readonly<{
  lockSettlement(tx: PawketTransaction, command: { orderId: string; creatorUserId: string; at: Date }): Promise<boolean>;
  confirmPayment(tx: PawketTransaction, command: CommissionSettlementCommand): Promise<boolean>;
}>;
