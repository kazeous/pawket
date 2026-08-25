import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { getIdentityRuntime } from "../../../auth/runtime";
import {
  safeSocialAuthError,
  socialAuthGuidance,
} from "../../../auth/social-auth-guidance";
import { SecurityPanel } from "./security-panel";
import { AppShell } from "../../../ui/app-shell";

export const dynamic = "force-dynamic";

export default async function SecuritySettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string | string[];
    "recover-totp"?: string | string[];
  }>;
}) {
  const runtime = getIdentityRuntime();
  const params = await searchParams;
  const session = await runtime.authenticate(await headers());
  if (!session) {
    const error = safeSocialAuthError(params.error);
    redirect(error ? `/sign-in?error=${encodeURIComponent(error)}` : "/sign-in");
  }
  const initialMessage = params.error
    ? socialAuthGuidance(params.error)
    : params["recover-totp"] === "1"
      ? "Mã khôi phục đã được chấp nhận. Hãy đăng ký lại ứng dụng xác thực ngay."
      : null;

  return (
    <AppShell context="Tài khoản" action={{ href: "/creator/apply", label: "Hồ sơ creator" }}>
      <header className="workspace-header reveal"><div><p className="eyebrow">Tài khoản</p><h1>Bảo mật &amp; đăng nhập</h1><p className="lede">Kiểm soát cách đăng nhập, xác thực hai bước và những thiết bị đang có quyền truy cập.</p></div></header>
      <SecurityPanel
        enabledProviders={runtime.auth.enabledProviders}
        initialMessage={initialMessage}
      />
    </AppShell>
  );
}
