import { isRecord, tipRequest, TipRequestError } from "../../../ui/tips/tip-client";
import { readTipPolicy, type TipPolicyView } from "../../../ui/tips/tip-policy-client";

export type OwnerTipPolicyEntry = TipPolicyView & Readonly<{ origin: "system_bootstrap" | "owner"; actorUserId: string | null; reason: string; previousPolicy: TipPolicyView | null }>;
export type OwnerTipPolicyData = Readonly<{ policy: TipPolicyView | null; history: { revisions: OwnerTipPolicyEntry[]; nextBeforeRevision: number | null }; paymentsEnabled: boolean; publishingEnabled: boolean }>;
export function readOwnerTipPolicyData(value: unknown): OwnerTipPolicyData {
  if (!isRecord(value) || typeof value.paymentsEnabled !== "boolean" || typeof value.publishingEnabled !== "boolean" || !isRecord(value.history) || !Array.isArray(value.history.revisions) || value.history.revisions.length > 25 ||
    (value.history.nextBeforeRevision !== null && (typeof value.history.nextBeforeRevision !== "number" || !Number.isSafeInteger(value.history.nextBeforeRevision) || value.history.nextBeforeRevision < 1))) throw new TipRequestError("dependency_unavailable");
  const policy = value.policy === null ? null : readTipPolicy(value.policy);
  const revisions = value.history.revisions.map((entry): OwnerTipPolicyEntry => {
    const snapshot = readTipPolicy(entry);
    if (!isRecord(entry) || !["system_bootstrap", "owner"].includes(String(entry.origin)) ||
      (entry.origin === "system_bootstrap" ? entry.actorUserId !== null : typeof entry.actorUserId !== "string" || entry.actorUserId.length < 1 || entry.actorUserId.length > 160) ||
      typeof entry.reason !== "string" || Array.from(entry.reason).length > 500) throw new TipRequestError("dependency_unavailable");
    const previousPolicy = entry.previousPolicy === null ? null : readTipPolicy(entry.previousPolicy);
    if (previousPolicy && previousPolicy.revisionNumber >= snapshot.revisionNumber) throw new TipRequestError("dependency_unavailable");
    return { ...snapshot, origin: entry.origin as OwnerTipPolicyEntry["origin"], actorUserId: entry.actorUserId as string | null, reason: entry.reason, previousPolicy };
  });
  if (revisions.some((entry, index) => index > 0 && entry.revisionNumber >= revisions[index - 1]!.revisionNumber)) throw new TipRequestError("dependency_unavailable");
  return { policy, history: { revisions, nextBeforeRevision: value.history.nextBeforeRevision as number | null }, paymentsEnabled: value.paymentsEnabled, publishingEnabled: value.publishingEnabled };
}
// Owner history is bounded to 25 revisions; each includes a prior snapshot and a
// 500-character reason. Keep the larger response allowance local to this API.
export const ownerTipPolicyRequest = (path: string, init?: RequestInit) => tipRequest(path, init, 131_072);
export function ownerTipPolicyError(code: string): string {
  switch (code) {
    case "owner_totp_required": return "Xác nhận mã TOTP để lưu đúng thay đổi đã xem lại.";
    case "authentication_required": return "Phiên đăng nhập đã hết hiệu lực. Đăng nhập lại để tiếp tục.";
    case "account_changed": return "Bạn đang đăng nhập bằng tài khoản khác. Đăng nhập lại đúng tài khoản đã mở trang này để tiếp tục; nội dung đang nhập vẫn được giữ nguyên.";
    case "owner_required": return "Tài khoản hiện tại không có quyền quản lý chính sách tip.";
    case "version_conflict": return "Chính sách đã thay đổi ở nơi khác. Tải bản mới và đối chiếu trước khi lưu lại.";
    case "idempotency_conflict": return "Lần lưu này không còn khớp. Tải chính sách mới để đối chiếu trước khi tạo thay đổi khác.";
    case "invalid_request": return "Dữ liệu chưa hợp lệ. Kiểm tra giới hạn, mức gợi ý và lý do thay đổi.";
    case "policy_unavailable": return "Chưa có chính sách tip hợp lệ. Cần kiểm tra cấu hình dữ liệu trước khi chỉnh sửa.";
    case "rate_limited": return "Bạn đã thử nhiều lần. Vui lòng đợi trước khi thử lại.";
    case "untrusted_origin": return "Không thể xác minh nguồn yêu cầu. Mở lại Pawket từ địa chỉ chính thức.";
    default: return "Chưa nhận được kết quả. Thử lại cùng lần lưu để kiểm tra; đừng tạo thay đổi khác khi kết quả chưa rõ.";
  }
}
