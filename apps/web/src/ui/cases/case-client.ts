import { z } from "zod";
import { tipRequest, TipRequestError, formatTipTime, formatVnd } from "../tips/tip-client";
export { formatTipTime, formatVnd };
const uuid = z.uuid(); const time = z.iso.datetime(); const amount = z.number().int().min(0).max(50_000_000);
export const caseKindLabels = { dispute: "Khiếu nại đơn hàng", refund_not_received: "Chưa nhận được hoàn tiền", refund_overdue: "Hoàn tiền quá hạn", late_payment: "Thanh toán sau khi đơn đóng" };
export type CaseKind = keyof typeof caseKindLabels;
export const evidenceLabels = { order_summary: "Thông tin đơn hàng", thread_page: "Tin nhắn và bàn giao", resolution_records: "Khiếu nại và hoàn tiền", refund_destination: "Tài khoản nhận hoàn tiền", file: "Tệp" };
export type EvidenceSection = Exclude<keyof typeof evidenceLabels, "file">;
const summary = z.object({ caseId: uuid, orderId: uuid, sourceId: uuid, sourceType: z.string(), kind: z.enum(["dispute", "refund_not_received", "refund_overdue", "late_payment"]),
  state: z.enum(["open", "resolved"]), resolutionKind: z.string().nullable(), policyRevisionId: uuid.nullable(), version: z.number().int().positive(), openedAt: time, resolvedAt: time.nullable() });
export const queueSchema = z.object({ cases: z.array(summary.extend({ nextDeadline: time.nullable() })).max(100) });
export const caseDetailSchema = z.object({ case: summary.extend({ creatorStanding: z.enum(["active", "suspended", "none"]), creatorUserId: z.string().min(1), buyerUserId: z.string().min(1),
  orderState: z.enum(["requested", "quoted", "awaiting_payment", "in_progress", "delivered", "completed", "closed"]), amountVnd: amount.nullable(),
  disputeOpenedAt: time.nullable(), respondBy: time.nullable(), nextDeadline: time.nullable().optional(),
  ruling: z.object({ id: uuid, outcome: z.enum(["complete", "close"]), refundAmountVnd: amount, ruledAt: time, correctionEndsAt: time.nullable() }).nullable(),
  events: z.array(z.object({ id: uuid, action: z.string(), reason: z.string().nullable(), beforeState: z.string().nullable(), afterState: z.string(), occurredAt: time, resultingVersion: z.number().int().positive() })),
  accessLog: z.array(z.object({ id: uuid, itemType: z.enum(["order_summary", "thread_page", "resolution_records", "refund_destination", "file"]), itemId: uuid,
    ownerUserId: z.string(), ownerSessionId: z.string(), accessedAt: time })).max(100) }) });
export const agingSchema = z.object({ refunds: z.array(z.object({ orderId: uuid, amountVnd: amount, ageDays: z.number().int().nonnegative() })).max(100) });
export type CaseQueueRow = z.infer<typeof queueSchema>["cases"][number];
export type CaseDetailView = z.infer<typeof caseDetailSchema>["case"];
export type AgingRefund = z.infer<typeof agingSchema>["refunds"][number];
export type CaseAction = Readonly<
  { action: "rule"; outcome: "complete" | "close"; refundAmountVnd: number; reasoning: string; internalNote?: string }
  | { action: "correct"; rulingId: string; newRefundAmountVnd: number; reason: string }
  | { action: "question"; text: string }
  | { action: "extend" | "extend_deadline"; until: string; reason: string }
  | { action: "accept_evidence" | "require_resend" | "waive"; reason: string }
  | { action: "rule_claim"; outcome: "refund_owed" | "rejected"; amountVnd?: number; reason: string }>;
// The shared request follows only the server's opaque OIDC review reference.
export const caseRequest: typeof tipRequest = (path, init = {}, maximumBytes = 1_048_576) => tipRequest(path, init, maximumBytes);
export function casePost(payload: unknown, actorUserId: string, key = crypto.randomUUID()): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key, "x-pawket-actor": actorUserId }, body: JSON.stringify(payload) };
}
export function readCase<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value); if (!result.success) throw new TipRequestError("dependency_unavailable"); return result.data;
}
export function openCaseFile(value: unknown) {
  const parsed = z.object({ url: z.url() }).safeParse(value); if (!parsed.success) throw new TipRequestError("dependency_unavailable");
  const url = new URL(parsed.data.url);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password) throw new TipRequestError("dependency_unavailable");
  window.open(url.href, "_blank", "noopener,noreferrer");
}
export function caseErrorText(code: string) {
  if (code === "OIDC_STEP_UP_REQUIRED") return "Đang chuyển đến trang xem lại và xác thực tài khoản.";
  if (code === "resolution_disabled") return "Tính năng xử lý khiếu nại và hoàn tiền đang tạm đóng.";
  if (["not_available", "invalid_transition", "version_conflict", "deadline_passed"].includes(code)) return "Vụ việc đã thay đổi hoặc thời hạn đã kết thúc. Hãy kiểm tra trạng thái hiện tại trước khi xử lý tiếp.";
  if (["owner_required", "authentication_required", "owner_step_up_required", "OIDC_ACTOR_CHANGED"].includes(code)) return "Cần xác thực lại tài khoản owner để tiếp tục.";
  if (code.startsWith("invalid_")) return "Thông tin chưa hợp lệ. Hãy kiểm tra số tiền, thời hạn và lý do.";
  return "Chưa lấy được kết quả. Kiểm tra lại cùng yêu cầu trước khi tạo thao tác khác.";
}
export const caseAge = (openedAt: string, now = new Date()) => Math.max(0, Math.floor((now.getTime() - Date.parse(openedAt)) / 86_400_000));
