import { isAllowedReturnPath } from "@pawket/identity";

import { SignInPanel } from "../sign-in-panel";
import { AppShell } from "../../../ui/app-shell";

export const dynamic = "force-dynamic";

export default async function MfaSignInPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  const requestedReturn = (await searchParams).returnTo;
  const returnTo =
    typeof requestedReturn === "string" && isAllowedReturnPath(requestedReturn)
      ? requestedReturn
      : "/settings/security";
  return (
    <AppShell width="narrow" action={null} context="Bảo mật">
      <div className="auth-layout reveal"><div className="auth-intro"><p className="eyebrow">Bước 2 / 2</p><h1>Xác nhận là bạn.</h1><p>Mã xác thực giúp bảo vệ tài khoản ngay cả khi mật khẩu bị lộ.</p></div><SignInPanel enabledProviders={[]} initialMfa returnTo={returnTo} /></div>
    </AppShell>
  );
}
