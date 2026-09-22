import type { Metadata } from "next";
import { getIdentityRuntime } from "../../../auth/runtime";
import { AppShell } from "../../../ui/app-shell";
import { SignInPanel } from "../sign-in-panel";
import { socialAuthGuidance } from "../../../auth/social-auth-guidance";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Xác thực lại · Pawket", robots: { index: false, follow: false }, referrer: "no-referrer" };
export default async function ReauthenticatePage({ searchParams }: Readonly<{ searchParams: Promise<{ error?: string | string[] }> }>) {
  const runtime = getIdentityRuntime(); const params = await searchParams;
  return <AppShell width="narrow" context="Xác thực lại" action={{ href: "/settings/security", label: "Bảo mật tài khoản" }}>
    <div className="auth-layout"><header className="auth-intro"><p className="eyebrow">Xác thực gần đây</p><h1>Đăng nhập lại để tiếp tục.</h1><p>Dùng đúng tài khoản ở tab chỉnh sửa. Sau khi đăng nhập, quay lại tab đó để tiếp tục lưu; nội dung đang nhập vẫn nằm ở tab ban đầu.</p></header>
      <SignInPanel enabledProviders={runtime.auth.enabledProviders} initialMessage={socialAuthGuidance(params.error)} returnTo="/settings/security" />
    </div>
  </AppShell>;
}
