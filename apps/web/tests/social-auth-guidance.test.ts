import { describe, expect, test } from "vitest";

import {
  safeSocialAuthError,
  socialAuthGuidance,
} from "../src/auth/social-auth-guidance";

describe("safe social-auth callback guidance", () => {
  test("directs an implicit-link collision through explicit account linking", () => {
    expect(socialAuthGuidance("account_not_linked")).toContain(
      "đăng nhập bằng phương thức cũ",
    );
    expect(socialAuthGuidance("account_not_linked")).toContain("liên kết nhà cung cấp");
  });

  test("distinguishes missing and unverified provider email without reflecting unknown errors", () => {
    expect(socialAuthGuidance("email_not_found")).toContain("chưa trả về email");
    expect(socialAuthGuidance("unable_to_create_user")).toContain("email ở nhà cung cấp đã được xác minh");
    expect(safeSocialAuthError("secret-provider-detail")).toBe("social");
    expect(socialAuthGuidance("secret-provider-detail")).not.toContain("secret-provider-detail");
    expect(safeSocialAuthError(["account_not_linked", "email_not_found"])).toBe("social");
    expect(socialAuthGuidance(["account_not_linked", "email_not_found"])).toContain(
      "Chưa thể hoàn tất",
    );
  });
});
