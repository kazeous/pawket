const notices: Record<string, string> = {
  auth_moved: "Đăng nhập, đổi mật khẩu và xác thực hai bước đã chuyển sang tài khoản reyuuGAMES.",
  transaction_expired: "Lượt đăng nhập đã hết hạn. Hãy bắt đầu lại.",
  email_unverified: "Hãy xác minh email tại trang tài khoản chung rồi đăng nhập lại.",
  identity_conflict: "Email này đang gắn với một tài khoản Pawket khác. Liên hệ người quản trị để nối đúng tài khoản.",
  actor_changed: "Tài khoản hoặc phiên đã thay đổi. Hãy quay lại thao tác ban đầu bằng đúng tài khoản.",
  assurance_required: "Thao tác cần xác thực lại bằng tài khoản chung và mã ứng dụng xác thực nếu đã bật.",
  session_revoked: "Phiên đã kết thúc. Hãy đăng nhập lại.",
  provider_unavailable: "Dịch vụ tài khoản đang tạm gián đoạn. Bạn vẫn có thể xem các trang công khai.",
  rate_limited: "Có quá nhiều lượt đăng nhập. Hãy đợi một lúc rồi thử lại.",
  invalid_response: "Chưa thể xác nhận lượt đăng nhập này. Hãy bắt đầu lại.",
};
export function oidcNotice(code?: string): string | null {
  return code ? notices[code] ?? notices.invalid_response! : null;
}
