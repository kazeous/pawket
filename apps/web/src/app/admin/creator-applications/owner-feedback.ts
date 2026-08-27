export type OwnerNotice = Readonly<{
  tone: "success" | "error" | "warning";
  text: string;
}>;

const ownerActionMessages: Readonly<Record<string, string>> = {
  STALE_VERSION: "Dữ liệu đã thay đổi. Queue vừa được tải lại.",
  CLAIM_UNAVAILABLE: "Hồ sơ đang được owner khác xét duyệt.",
  CLAIM_EXPIRED: "Claim đã hết hạn. Hãy claim lại hồ sơ.",
  PAYMENTS_POLICY_REJECTED: "Thao tác thanh toán không khớp chính sách hiện tại.",
  CREATOR_REVIEW_UNAVAILABLE: "Dịch vụ xét duyệt đang tạm gián đoạn.",
  PAYMENTS_UNAVAILABLE: "Dịch vụ thanh toán đang tạm gián đoạn.",
  INVALID_DECISION: "Quyết định hoặc phần giải thích chưa hợp lệ.",
  INVALID_STATE: "Trạng thái hồ sơ không còn cho phép thao tác này.",
  MISSING_REVISION: "Hồ sơ chưa có revision để xét duyệt.",
  AGE_SNAPSHOT_INVALID: "Snapshot độ tuổi của hồ sơ không hợp lệ.",
  SNAPSHOT_INCOMPLETE: "Snapshot hồ sơ chưa đầy đủ.",
  ACCOUNT_INELIGIBLE: "Tài khoản creator không còn đủ điều kiện.",
  EMAIL_CHANGED: "Email hiện tại không còn khớp snapshot đã gửi.",
  MISSING_RECEIVING_ACCOUNT: "Hồ sơ chưa gắn tài khoản nhận tiền.",
  ATTESTATIONS_INVALID: "Các xác nhận chính sách của revision chưa đầy đủ.",
  PROOF_EXPIRED: "Bằng chứng kiểm soát tài khoản nhận tiền đã hết hạn.",
  RECEIVING_ACCOUNT_UNVERIFIED: "Tài khoản nhận tiền chưa có thử thách đã xác minh phù hợp.",
  REFUND_OBLIGATION_MISSING: "Chưa có nghĩa vụ hoàn trả gắn đúng bằng chứng xác minh.",
  CREATOR_CAPABILITY_EXISTS: "Tài khoản này đã có capability creator.",
  IDEMPOTENCY_CONFLICT: "Thao tác trùng lặp đang có nội dung khác.",
  IDEMPOTENCY_INVALID: "Kết quả thao tác trước không còn hợp lệ.",
  IDEMPOTENCY_FAILED: "Chưa thể hoàn tất bản ghi idempotency.",
};

const unmatchedReasons: Readonly<Record<string, string>> = {
  amount_mismatch: "số tiền không khớp",
  reference_mismatch: "mã tham chiếu không khớp",
  source_mismatch: "tài khoản nguồn không khớp",
  unidentified_source: "chưa xác định được tài khoản nguồn",
  late: "giao dịch đến sau khi thử thách hết hạn",
  duplicate: "thử thách đã được đối soát trước đó",
};

export function ownerActionMessage(code: string): string {
  const known = ownerActionMessages[code];
  if (known) return known;
  return /^[A-Z0-9_]{1,100}$/u.test(code)
    ? `Chưa thể hoàn tất thao tác owner (mã ${code}).`
    : "Chưa thể hoàn tất thao tác owner.";
}

export function reconciliationNotice(payload: Record<string, unknown>): OwnerNotice {
  const reconciliation = payload.reconciliation;
  if (!reconciliation || typeof reconciliation !== "object" || Array.isArray(reconciliation)) {
    throw new Error("Reconciliation response is invalid");
  }
  const result = reconciliation as Record<string, unknown>;
  if (result.kind === "matched") {
    return {
      tone: "success",
      text: "Đã đối soát khớp và tạo nghĩa vụ hoàn trả. Danh sách hoàn trả đã được làm mới.",
    };
  }
  if (result.kind === "unmatched") {
    const reason = typeof result.reason === "string" ? result.reason : "unknown";
    return {
      tone: "warning",
      text: `Giao dịch được ghi nhận là chưa khớp: ${unmatchedReasons[reason] ?? reason}. Chưa tạo nghĩa vụ hoàn trả.`,
    };
  }
  throw new Error("Reconciliation response is invalid");
}
