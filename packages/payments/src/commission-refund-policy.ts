import { randomBytes } from "node:crypto";

export const COMMISSION_REFUND_POLICY = Object.freeze({ sendBusinessDays: 5, confirmWindowMs: 604_800_000,
  purgeAfterMs: 2_592_000_000, agingAfterMs: 2_592_000_000, maxExtensionMs: 2_592_000_000 });
export type CommissionRefundSource = "agreement" | "ruling" | "correction" | "late_payment" | "late_payment_provider" | "suspension_cancel" | "fulfillment_freeze";
export type CommissionRefundState = "awaiting_destination" | "awaiting_send" | "sent" | "received" | "presumed_received" | "not_received" | "waived";
export class CommissionRefundError extends Error {
  constructor(readonly code: "invalid_request" | "not_available" | "invalid_transition" | "version_conflict" | "dependency_unavailable") {
    super(code); this.name = "CommissionRefundError";
  }
}
export function refundFail(code: CommissionRefundError["code"]): never { throw new CommissionRefundError(code); }
export function createRefundReference(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  return `PKR${[...randomBytes(12)].map((byte) => alphabet[byte & 31]).join("")}`;
}
export function normalizeBankReference(value: unknown): string {
  if (typeof value !== "string") refundFail("invalid_request");
  const result = value.trim();
  if (!/^[A-Za-z0-9._/-]{1,64}$/u.test(result)) refundFail("invalid_request");
  return result;
}
