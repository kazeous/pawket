import type { AuthorizedTipReceipt, TipInstructionProjection, TipReceiptProjection } from "@pawket/payments";
import type { PublicTipOffering } from "@pawket/tips";

export const formatVnd = (value: number) => `${new Intl.NumberFormat("vi-VN").format(value)} ₫`;
export const formatTipTime = (value: string) => new Intl.DateTimeFormat("vi-VN", {
  dateStyle: "short", timeStyle: "short", timeZone: "Asia/Ho_Chi_Minh",
}).format(new Date(value));
export class TipRequestError extends Error {
  constructor(readonly code: string) { super(code); }
}

export async function tipRequest(path: string, init: RequestInit = {}, maximumBytes = 16_384): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(path, { ...init, credentials: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: controller.signal });
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json") || !response.body) throw new TipRequestError("dependency_unavailable");
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
    try {
      for (;;) { const { value, done } = await reader.read(); if (done) break; total += value.byteLength;
        if (total > maximumBytes) { await reader.cancel(); throw new TipRequestError("dependency_unavailable"); } chunks.push(value); }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!response.ok) throw new TipRequestError(isRecord(payload) && typeof payload.code === "string" ? payload.code : "dependency_unavailable");
    return payload;
  } catch (error) {
    if (error instanceof TipRequestError) throw error;
    throw new TipRequestError("dependency_unavailable");
  } finally { clearTimeout(timer); }
}
export const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
// Drafts live only in this mounted form. Reauthentication can replace the
// shared session cookie, so verify the account before using any saved intent.
export async function requireTipDraftActor(expectedUserId: string): Promise<void> {
  let value: unknown;
  try { value = await tipRequest("/api/v1/me"); }
  catch (error) {
    if (error instanceof TipRequestError && error.code === "AUTHENTICATION_REQUIRED") throw new TipRequestError("authentication_required");
    if (error instanceof TipRequestError && error.code === "IDENTITY_UNAVAILABLE") throw new TipRequestError("dependency_unavailable");
    throw error;
  }
  if (!isRecord(value) || !isRecord(value.user) || typeof value.user.id !== "string") throw new TipRequestError("dependency_unavailable");
  if (value.user.id !== expectedUserId) throw new TipRequestError("account_changed");
}
export function readTipOffering(value: unknown, handle: string): PublicTipOffering {
  const v = isRecord(value) ? value.offering : null;
  if (!isRecord(v) || v.canonicalHandle !== handle || typeof v.displayName !== "string" || Array.from(v.displayName).length < 1 || Array.from(v.displayName).length > 80 ||
    typeof v.minimumVnd !== "number" || typeof v.maximumVnd !== "number" || !Number.isSafeInteger(v.minimumVnd) || !Number.isSafeInteger(v.maximumVnd) || v.minimumVnd < 10_000 || v.maximumVnd > 5_000_000 || v.minimumVnd > v.maximumVnd ||
    !Array.isArray(v.presetsVnd) || v.presetsVnd.length !== 3 || new Set(v.presetsVnd).size !== 3 || v.presetsVnd.some((amount) => typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < (v.minimumVnd as number) || amount > (v.maximumVnd as number))) throw new TipRequestError("dependency_unavailable");
  return { canonicalHandle: handle, displayName: v.displayName, minimumVnd: v.minimumVnd, maximumVnd: v.maximumVnd, presetsVnd: [...v.presetsVnd] as number[] };
}
export function readCreatedInstruction(value: unknown, handle: string, amount: number): TipInstructionProjection {
  const v = isRecord(value) ? value.instruction : null;
  if (!isRecord(v) || typeof v.reference !== "string" || !/^PW[0-9A-F]{20}$/u.test(v.reference) ||
    !isRecord(v.creator) || v.creator.handle !== handle || typeof v.creator.displayName !== "string" || Array.from(v.creator.displayName).length > 80 ||
    v.amountVnd !== amount || v.currency !== "VND" || v.state !== "awaiting_transfer" ||
    typeof v.expiresAt !== "string" || !Number.isFinite(Date.parse(v.expiresAt)) || v.confirmedAt !== null ||
    (v.transferClaimedAt !== null && (typeof v.transferClaimedAt !== "string" || !Number.isFinite(Date.parse(v.transferClaimedAt)))) ||
    !isRecord(v.destination) || typeof v.destination.bankBin !== "string" || !/^\d{6}$/u.test(v.destination.bankBin) ||
    typeof v.destination.bankName !== "string" || v.destination.bankName.length > 100 || typeof v.destination.accountName !== "string" || Array.from(v.destination.accountName).length > 100 ||
    typeof v.destination.accountNumber !== "string" || !/^\d{6,19}$/u.test(v.destination.accountNumber) ||
    typeof v.qrPayload !== "string" || v.qrPayload.length < 50 || v.qrPayload.length > 1000) throw new TipRequestError("dependency_unavailable");
  // Only the known authorized display fields cross into component state.
  return { reference: v.reference, creator: { handle, displayName: v.creator.displayName }, amountVnd: amount as TipInstructionProjection["amountVnd"], currency: "VND",
    state: "awaiting_transfer", expiresAt: v.expiresAt, confirmedAt: null, transferClaimedAt: v.transferClaimedAt as string | null,
    destination: { bankBin: v.destination.bankBin, bankName: v.destination.bankName, accountNumber: v.destination.accountNumber, accountName: v.destination.accountName }, qrPayload: v.qrPayload };
}
export function tipErrorText(code: string) {
  switch (code) {
    case "payments_disabled": return "Tính năng tip đang tạm đóng.";
    case "not_available": return "Nghệ sĩ hiện chưa thể nhận tip này. Vui lòng tải lại trang để kiểm tra.";
    case "rate_limited": return "Bạn đã thử nhiều lần. Vui lòng đợi trước khi thử lại.";
    case "invalid_amount": return "Số tiền không còn phù hợp. Vui lòng kiểm tra lại.";
    case "policy_changed": return "Chính sách số tiền vừa thay đổi. Hãy kiểm tra giới hạn mới bên trên và chọn lại số tiền nếu cần. Số tiền, tên và lời nhắn bạn đã nhập vẫn được giữ nguyên.";
    case "invalid_guest_content": return "Tên hoặc lời nhắn chưa hợp lệ. Vui lòng kiểm tra độ dài và ký tự.";
    case "guest_context_required": return "Trình duyệt cần cho phép cookie để lưu quyền xem tip. Hãy bật cookie rồi thử lại.";
    case "idempotency_conflict": case "intent_not_pending": return "Yêu cầu này không thể tiếp tục. Vui lòng kiểm tra phiếu tip đã tạo trước khi gửi yêu cầu khác.";
    default: return "Chưa lấy được kết quả. Bấm thử lại để kiểm tra cùng yêu cầu; chưa cần tạo tip khác.";
  }
}

export type TipReceiptViewData = AuthorizedTipReceipt & Readonly<{ paymentsEnabled: boolean }>;
export type TipReceiptPageState = Readonly<{ kind: "ready"; data: TipReceiptViewData }> | Readonly<{ kind: "unavailable"; code: string }>;
export function readTipReceipt(value: unknown, reference: string): TipReceiptViewData {
  const r = isRecord(value) ? value.receipt : null;
  const validTime = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
  if (!isRecord(value) || !isRecord(r) || !/^PW[0-9A-F]{20}$/u.test(reference) || r.reference !== reference ||
    !isRecord(r.creator) || typeof r.creator.handle !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(r.creator.handle) || r.creator.handle.length < 3 || r.creator.handle.length > 30 ||
    typeof r.creator.displayName !== "string" || Array.from(r.creator.displayName).length < 1 || Array.from(r.creator.displayName).length > 80 ||
    typeof r.amountVnd !== "number" || !Number.isSafeInteger(r.amountVnd) || r.amountVnd < 10_000 || r.amountVnd > 5_000_000 || r.currency !== "VND" ||
    typeof r.state !== "string" || !["awaiting_transfer", "confirmed", "expired", "rejected"].includes(r.state) || !validTime(r.expiresAt) ||
    (r.state === "confirmed" ? !validTime(r.confirmedAt) : r.confirmedAt !== null) ||
    (r.transferClaimedAt !== null && !validTime(r.transferClaimedAt)) || typeof value.paymentsEnabled !== "boolean") throw new TipRequestError("dependency_unavailable");
  const receipt: TipReceiptProjection = { reference, creator: { handle: r.creator.handle, displayName: r.creator.displayName },
    amountVnd: r.amountVnd as TipReceiptProjection["amountVnd"], currency: "VND", state: r.state as TipReceiptProjection["state"], expiresAt: r.expiresAt,
    confirmedAt: r.confirmedAt as string | null, transferClaimedAt: r.transferClaimedAt as string | null };
  let instruction: TipInstructionProjection | null = null;
  if (value.instruction !== null) {
    if (!value.paymentsEnabled || receipt.state !== "awaiting_transfer") throw new TipRequestError("dependency_unavailable");
    instruction = readCreatedInstruction(value, receipt.creator.handle, receipt.amountVnd);
    if (instruction.reference !== receipt.reference || instruction.expiresAt !== receipt.expiresAt || instruction.creator.displayName !== receipt.creator.displayName || instruction.transferClaimedAt !== receipt.transferClaimedAt) throw new TipRequestError("dependency_unavailable");
  }
  return { receipt, instruction, paymentsEnabled: value.paymentsEnabled };
}
