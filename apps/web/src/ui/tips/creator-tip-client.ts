import type { CreatorTipProjection, CreatorTipQueue, PaymentIntentState } from "@pawket/payments";
import type { CreatorTipSettingsSnapshot } from "@pawket/catalog";
import { isRecord, TipRequestError } from "./tip-client";
import { readTipPolicy } from "./tip-policy-client";

export const tipStateLabels: Record<PaymentIntentState, string> = {
  awaiting_transfer: "Chờ chuyển khoản", confirmed: "Đã xác nhận", expired: "Đã hết hạn", rejected: "Đã từ chối",
};
export const creatorTipPath = (state: PaymentIntentState, cursor?: string) => `/creator/tips?state=${state}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
export type CreatorTipSettingsView = CreatorTipSettingsSnapshot & Readonly<{ available: boolean }>;
export function readCreatorTipSettings(s: unknown): CreatorTipSettingsSnapshot {
  if (!isRecord(s) || typeof s.revisionNumber !== "number" || !Number.isInteger(s.revisionNumber) || s.revisionNumber < 0 ||
    (s.revisionNumber === 0 ? s.revisionId !== null : typeof s.revisionId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(s.revisionId)) ||
    typeof s.enabled !== "boolean" || typeof s.minimumVnd !== "number" || typeof s.maximumVnd !== "number" || !Number.isSafeInteger(s.minimumVnd) || !Number.isSafeInteger(s.maximumVnd) || s.minimumVnd < 10_000 || s.maximumVnd > 5_000_000 || s.minimumVnd > s.maximumVnd ||
    !Array.isArray(s.presetsVnd) || s.presetsVnd.length !== 3 || new Set(s.presetsVnd).size !== 3 || s.presetsVnd.some((v) => typeof v !== "number" || !Number.isInteger(v) || v < (s.minimumVnd as number) || v > (s.maximumVnd as number))) throw new TipRequestError("dependency_unavailable");
  const effectivePolicy = s.effectivePolicy === null ? null : readTipPolicy(s.effectivePolicy);
  if ((s.platformPolicyRevisionId !== null && (typeof s.platformPolicyRevisionId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(s.platformPolicyRevisionId))) ||
    typeof s.presetsFallback !== "boolean" || !Array.isArray(s.effectivePresetsVnd)) throw new TipRequestError("dependency_unavailable");
  const fallback = Boolean(effectivePolicy && !s.presetsVnd.every((v) => effectivePolicy.allowedPresetsVnd.includes(v as number)));
  const effectivePresets = effectivePolicy ? fallback ? effectivePolicy.allowedPresetsVnd.slice(0, 3) : s.presetsVnd : [];
  if (s.presetsFallback !== fallback || JSON.stringify(s.effectivePresetsVnd) !== JSON.stringify(effectivePresets)) throw new TipRequestError("dependency_unavailable");
  return { revisionId: s.revisionId as string | null, revisionNumber: s.revisionNumber, enabled: s.enabled, minimumVnd: s.minimumVnd, maximumVnd: s.maximumVnd, presetsVnd: [...s.presetsVnd] as number[],
    platformPolicyRevisionId: s.platformPolicyRevisionId as string | null, effectivePolicy, effectivePresetsVnd: [...s.effectivePresetsVnd] as number[], presetsFallback: s.presetsFallback };
}
export function readCreatorTip(v: unknown): CreatorTipProjection {
  const validTime = (t: unknown): t is string => typeof t === "string" && Number.isFinite(Date.parse(t));
  if (!isRecord(v) || typeof v.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v.id) ||
    typeof v.reference !== "string" || !/^PW[A-F0-9]{20}$/u.test(v.reference) || typeof v.amountVnd !== "number" || !Number.isSafeInteger(v.amountVnd) || v.amountVnd < 10_000 || v.amountVnd > 5_000_000 ||
    typeof v.state !== "string" || !Object.hasOwn(tipStateLabels, v.state) || !validTime(v.expiresAt) || (v.transferClaimedAt !== null && !validTime(v.transferClaimedAt))) throw new TipRequestError("dependency_unavailable");
  const common = { id: v.id, reference: v.reference, amountVnd: v.amountVnd as CreatorTipProjection["amountVnd"], expiresAt: v.expiresAt, transferClaimedAt: v.transferClaimedAt as string | null };
  if (v.state === "confirmed") {
    const text = (t: unknown, maximum: number): t is string | null => t === null || (typeof t === "string" && Array.from(t).length <= maximum);
    if (!validTime(v.confirmedAt) || !isRecord(v.guestContent) || !text(v.guestContent.name, 80) || !text(v.guestContent.message, 280)) throw new TipRequestError("dependency_unavailable");
    return { ...common, state: "confirmed", confirmedAt: v.confirmedAt, guestContent: { name: v.guestContent.name, message: v.guestContent.message } };
  }
  if (v.confirmedAt !== null || Object.hasOwn(v, "guestContent")) throw new TipRequestError("dependency_unavailable");
  return { ...common, state: v.state as Exclude<PaymentIntentState, "confirmed">, confirmedAt: null };
}
export function readCreatorTipQueue(value: unknown): CreatorTipQueue {
  const q = isRecord(value) ? value.queue : null;
  if (!isRecord(q) || !Array.isArray(q.items) || q.items.length > 100 || (q.nextCursor !== null && (typeof q.nextCursor !== "string" || q.nextCursor.length > 400 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(q.nextCursor)))) throw new TipRequestError("dependency_unavailable");
  return { items: q.items.map(readCreatorTip), nextCursor: q.nextCursor as string | null };
}
export function creatorTipErrorText(code: string): string {
  switch (code) {
    case "recent_auth_required": case "authentication_required": return "Hãy đăng nhập lại để xác thực gần đây, rồi mở lại trang tip để đối chiếu.";
    case "totp_required": return "Nhập mã từ ứng dụng xác thực để tiếp tục xác nhận.";
    case "evidence_mismatch": case "invalid_amount": case "invalid_request": return "Dữ liệu đối chiếu chưa khớp hoặc chưa hợp lệ. Kiểm tra giao dịch ngân hàng và nhập lại.";
    case "bank_transaction_conflict": return "Mã giao dịch ngân hàng này đã được dùng để xác nhận tip. Kiểm tra lại lịch sử trước khi tiếp tục.";
    case "intent_not_pending": case "idempotency_conflict": return "Tip này không còn có thể xác nhận bằng yêu cầu này. Tải lại danh sách để kiểm tra trạng thái.";
    case "payments_disabled": return "Tính năng tip đang tạm đóng. Bạn vẫn có thể xem lịch sử.";
    case "not_available": return "Chưa thể xác nhận tip này. Tải lại danh sách và kiểm tra tài khoản nhận tiền của bạn.";
    case "rate_limited": return "Bạn đã thử nhiều lần. Vui lòng đợi trước khi thử lại.";
    default: return "Chưa nhận được kết quả. Thử lại cùng yêu cầu để kiểm tra, hoặc đóng hộp thoại và tải lại danh sách trước khi thao tác tiếp.";
  }
}
