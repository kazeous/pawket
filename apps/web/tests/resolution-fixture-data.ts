import { resolutionSchema, type RefundView } from "../src/ui/resolutions/resolution-client";
import type { OrderView } from "../src/ui/commissions/commission-client";

export const orderId = "10000000-0000-4000-8000-000000000001";
export const obligationId = "10000000-0000-4000-8000-000000000002";
export const actorId = "synthetic-resolution-actor";
export const resolutionFormLabels = {
  statement: "Trình bày bắt buộc",
  transferDate: "Ngày chuyển bắt buộc",
  bankReference: "Mã giao dịch ngân hàng bắt buộc",
  staffReview: "Khi mở khiếu nại, Pawket sẽ xem tin nhắn và tệp riêng tư của đơn này để xem xét.",
} as const;
const at = "2026-10-08T00:00:00.000Z";
export const fixtureOrder: OrderView["order"] = { id: orderId, version: 1, role: "buyer", state: "in_progress", route: "fixed_immediate", closeReason: null,
  createdAt: at, expiresAt: null, acceptedAt: at, confirmedAt: at, dueAt: "2026-10-15T00:00:00.000Z", overdue: false, deadlinePassed: false,
  fulfillment: { deliveredAt: null, reviewEndsAt: null, completionDueAt: null, completedAt: null, completionKind: null, revisionsUsed: 0, revisionAllowance: 0, lateDelivery: false, fileDeletionAt: null },
  package: { id: orderId, revisionId: orderId, title: "Commission" }, brief: { text: "", referenceLinks: [] }, referenceFiles: [], terms: null, policy: null, currentPolicy: null, quote: null, payment: null };
export const fixtureRefund: RefundView = { obligationId, source: "agreement", sourceId: orderId, amountVnd: 100_000, reference: "PKR000000000000", state: "awaiting_send",
  bankBin: "970436", bankName: "Synthetic bank", suffix: "4321", dueAt: "2026-10-15T00:00:00.000Z", confirmBy: null, endedAt: null, destinationPurgedAt: null,
  currentSendId: null, hasRecordedSend: false, version: 1, createdAt: at, sends: [] };
export function fixtureResolution(surface: string) {
  const role = surface === "creator" ? "creator" : "buyer";
  return resolutionSchema.parse({ controls: { mode: "enabled" }, resolution: { role, proposals: { pending: null, history: [] }, dispute: null,
    refunds: surface === "creator" ? [fixtureRefund] : [], lateClaim: null,
    actions: { canPropose: surface === "buyer", canOpenDispute: surface === "buyer", disputeTrigger: "overdue", disputeTriggerEndsAt: null, canCancelAfterSuspension: surface === "buyer" } } });
}
