import type { Metadata } from "next";
import { getIdentityRuntime } from "../../../auth/runtime";
import { AppShell } from "../../../ui/app-shell";
import { SignInPanel } from "../sign-in-panel";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Xác thực lại · Pawket", robots: { index: false, follow: false }, referrer: "no-referrer" };
// Opened in a new tab from a page that keeps the user's draft. The login is forced so the
// account site asks for the password and TOTP again instead of reusing its current session.
export default function ReauthenticatePage() {
  const runtime = getIdentityRuntime();
  return <AppShell width="narrow" context="Xác thực lại" action={{ href: "/settings/security", label: "Bảo mật tài khoản" }}>
    <div className="auth-layout"><header className="auth-intro"><p className="eyebrow">Xác thực gần đây</p><h1>Đăng nhập lại để tiếp tục.</h1><p>Dùng đúng tài khoản ở tab chỉnh sửa. Sau khi đăng nhập, quay lại tab đó để tiếp tục lưu; nội dung đang nhập vẫn nằm ở tab ban đầu.</p></header>
      <SignInPanel accountPortalUrl={runtime.accountPortalUrl} returnTo="/settings/security" reauthenticate />
    </div>
  </AppShell>;
}
