import { commissionFail, type CommissionCloseReason, type CommissionState } from "./contracts.js";

const closeReasons: Readonly<Record<CommissionState, readonly CommissionCloseReason[]>> = Object.freeze({
  requested: ["buyer_withdrawn", "creator_declined", "request_expired", "security_invalidated", "eligibility_invalidated"],
  quoted: ["buyer_withdrawn", "quote_withdrawn", "quote_declined", "quote_expired", "security_invalidated", "eligibility_invalidated"],
  awaiting_payment: ["buyer_cancelled", "creator_cancelled", "payment_expired", "security_invalidated", "eligibility_invalidated"],
  in_progress: [],
  delivered: [],
  completed: [],
  closed: [],
});

/** Paid-order completion follows delivery; completed orders are terminal. */
export function requireCommissionTransition(from: CommissionState, to: CommissionState, reason?: CommissionCloseReason): void {
  if (to === "closed") {
    if (!reason || !closeReasons[from]?.includes(reason)) commissionFail("invalid_transition");
    return;
  }
  if (reason !== undefined || !(
    (from === "requested" && (to === "quoted" || to === "awaiting_payment")) ||
    (from === "quoted" && (to === "quoted" || to === "awaiting_payment")) ||
    (from === "awaiting_payment" && to === "in_progress") ||
    (from === "in_progress" && (to === "delivered" || to === "in_progress")) ||
    (from === "delivered" && (to === "in_progress" || to === "completed"))
  )) commissionFail("invalid_transition");
}
