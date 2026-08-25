type SafeSocialAuthError =
  | "account_not_linked"
  | "email_not_found"
  | "unable_to_create_user"
  | "account_already_linked_to_different_user"
  | "social";

const SAFE_ERRORS = new Set<SafeSocialAuthError>([
  "account_not_linked",
  "email_not_found",
  "unable_to_create_user",
  "account_already_linked_to_different_user",
  "social",
]);

export function safeSocialAuthError(
  value: string | string[] | undefined,
): SafeSocialAuthError | null {
  if (!value) return null;
  if (Array.isArray(value)) return value.length > 0 ? "social" : null;
  const normalized = value.trim().toLowerCase();
  return SAFE_ERRORS.has(normalized as SafeSocialAuthError)
    ? (normalized as SafeSocialAuthError)
    : "social";
}

export function socialAuthGuidance(value: string | string[] | undefined): string | null {
  switch (safeSocialAuthError(value)) {
    case "account_not_linked":
      return "Email này đã thuộc một tài khoản Pawket. Hãy đăng nhập bằng phương thức cũ rồi liên kết nhà cung cấp trong phần Bảo mật.";
    case "email_not_found":
      return "Nhà cung cấp chưa trả về email. Hãy bổ sung email ở nhà cung cấp rồi thử lại.";
    case "unable_to_create_user":
      return "Pawket chưa thể chấp nhận danh tính này. Hãy kiểm tra email ở nhà cung cấp đã được xác minh.";
    case "account_already_linked_to_different_user":
      return "Danh tính này đã được liên kết với tài khoản Pawket khác.";
    case "social":
      return "Chưa thể hoàn tất đăng nhập qua nhà cung cấp. Hãy thử lại.";
    case null:
      return null;
  }
}
