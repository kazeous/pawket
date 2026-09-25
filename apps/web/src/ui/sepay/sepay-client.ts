import type { SePayConnectionSnapshot, SePayConnectionView, SePayReviewQueue } from "@pawket/payments";
import { isRecord, TipRequestError } from "@/ui/tips/tip-client";
export const sepayStatusLabels: Record<string, string> = { setup_pending: "Chờ hoàn tất kết nối", ready: "Đã kết nối", paused: "Đã tạm dừng", reconnect_required: "Cần kết nối lại", disconnected: "Đã ngắt kết nối", pending: "Chờ đối soát", processing: "Đang đối soát", review_required: "Cần kiểm tra", confirmed: "Đã xác nhận", dismissed: "Đã đóng kiểm tra" };
const id = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/u.test(v);
export function readSePayConnection(v: unknown): SePayConnectionView {
  if (!isRecord(v) || !id(v.id) || !Number.isSafeInteger(v.version) || Number(v.version) < 1 || typeof v.status !== "string" || !["setup_pending", "ready", "paused", "reconnect_required", "disconnected"].includes(v.status) || typeof v.bankName !== "string" || v.bankName.length > 100 || typeof v.maskedSuffix !== "string" || !/^•••• [0-9]{4}$/u.test(v.maskedSuffix) || typeof v.automationEnabled !== "boolean" ||
    (v.cutoverAt !== null && (typeof v.cutoverAt !== "string" || !Number.isFinite(Date.parse(v.cutoverAt)))) || typeof v.webhookEndpoint !== "string" || v.webhookEndpoint.length > 2048 || !["not_requested", "unknown", "revoked"].includes(String(v.remoteRevocationStatus))) throw new TipRequestError("dependency_unavailable");
  return { id: v.id, version: Number(v.version), status: v.status, bankName: v.bankName, maskedSuffix: v.maskedSuffix, automationEnabled: v.automationEnabled,
    cutoverAt: v.cutoverAt as string | null, webhookEndpoint: v.webhookEndpoint, remoteRevocationStatus: String(v.remoteRevocationStatus) };
}
export function readSePaySnapshot(value: unknown): SePayConnectionSnapshot {
  const v = isRecord(value) ? value.snapshot : null;
  if (!isRecord(v) || typeof v.available !== "boolean" || ![null, "payments_disabled", "provider_contract_pending"].includes(v.blockReason as null)) throw new TipRequestError("dependency_unavailable");
  return { available: v.available, blockReason: v.blockReason as SePayConnectionSnapshot["blockReason"], connection: v.connection === null ? null : readSePayConnection(v.connection) };
}
export function readSePayQueue(value: unknown): SePayReviewQueue {
  const q = isRecord(value) ? value.queue : null;
  if (!isRecord(q) || !Array.isArray(q.items) || q.items.length > 50 || (q.nextCursor !== null && !id(q.nextCursor))) throw new TipRequestError("dependency_unavailable");
  return { nextCursor: q.nextCursor as string | null, items: q.items.map((v: unknown) => {
    if (!isRecord(v) || !id(v.id) || !id(v.connectionId) || !Number.isSafeInteger(v.version) || Number(v.version) < 1 || typeof v.status !== "string" || !["pending", "processing", "review_required", "confirmed", "dismissed"].includes(v.status) || (v.reason !== null && (typeof v.reason !== "string" || !/^[a-z][a-z0-9_]{0,63}$/u.test(v.reason))) ||
      (v.amountVnd !== null && (!Number.isSafeInteger(v.amountVnd) || Number(v.amountVnd) < 1)) || (v.reference !== null && (typeof v.reference !== "string" || !/^PW[A-F0-9]{20}$/u.test(v.reference))) || typeof v.receivedAt !== "string" || !Number.isFinite(Date.parse(v.receivedAt))) throw new TipRequestError("dependency_unavailable");
    return { id: v.id, connectionId: v.connectionId, version: Number(v.version), status: v.status, reason: v.reason as string | null,
      amountVnd: v.amountVnd as number | null, reference: v.reference as string | null, receivedAt: v.receivedAt };
  }) };
}
export function sepayErrorText(code: string): string {
  switch (code) {
    case "authentication_required": case "recent_auth_required": return "Hãy đăng nhập lại rồi quay về đây để tiếp tục.";
    case "totp_required": return "Hãy xác thực bằng mã từ ứng dụng xác thực trước khi tiếp tục.";
    case "payments_disabled": return "Tính năng tip đang tạm đóng. Bạn vẫn có thể xem lịch sử.";
    case "provider_unavailable": case "provider_contract_pending": case "contract_unverified": return "Kết nối SePay chưa sẵn sàng. Hệ thống chưa thể tự động xác nhận giao dịch.";
    case "open_manual_intents": return "Vẫn còn tip đang chờ đối chiếu thủ công. Hoàn tất các tip đó hoặc đợi chúng hết hạn trước khi bật tự đối soát.";
    case "account_conflict": return "Chưa thể bật tự đối soát cho tài khoản nhận tiền này. Hãy kiểm tra lại tài khoản đã xác minh.";
    case "version_conflict": case "idempotency_conflict": return "Dữ liệu vừa thay đổi. Tải lại và kiểm tra trạng thái trước khi thao tác tiếp.";
    case "reconnect_required": case "connection_not_ready": return "Cần kết nối lại SePay. Các tip qua SePay chưa thể được xác nhận lúc này.";
    case "reference_mismatch": return "Nội dung chuyển khoản chưa khớp mã tip đầy đủ.";
    case "amount_mismatch": return "Số tiền chuyển khoản khác số tiền của tip.";
    case "before_cutover": case "time_mismatch": case "expired": case "intent_not_pending": return "Thời điểm giao dịch hoặc trạng thái tip không đủ điều kiện xác nhận.";
    case "contradictory_replay": case "identity_mismatch": case "evidence_mismatch": return "Thông tin giao dịch chưa nhất quán. Hệ thống chưa xác nhận tiền cho tip này.";
    case "automation_paused": return "Tự đối soát đang tạm dừng.";
    case "not_found": case "readback_inconclusive": return "Chưa có đủ thông tin độc lập từ SePay để xác nhận giao dịch.";
    case "rate_limited": return "Đã có nhiều yêu cầu. Vui lòng đợi rồi thử lại.";
    case "account_changed": return "Tài khoản đăng nhập đã thay đổi. Tải lại trang trước khi tiếp tục.";
    default: return "Chưa lấy được kết quả. Tải lại để kiểm tra; nếu cần thử lại, giữ nguyên yêu cầu hiện tại.";
  }
}
