import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { SignInPanel } from "./sign-in-panel";
import { getIdentityRuntime } from "../../auth/runtime";
import { AppShell } from "../../ui/app-shell";
import { safeOidcReturnPath } from "@pawket/identity";
import { oidcNotice } from "../../auth/oidc-notice";

export const dynamic = "force-dynamic";
export default async function SignInPage({ searchParams }: { searchParams: Promise<{ notice?: string; returnTo?: string }> }) {
  const runtime = getIdentityRuntime(); const params = await searchParams;
  const destination = safeOidcReturnPath(params.returnTo ?? "/settings/security");
  const session = await runtime.authenticate(await headers(), true);
  if (session && !session.leaseRequired && !params.notice) redirect(destination);
  return <AppShell width="narrow" context="Tài khoản">
    <div className="auth-layout reveal">
      <div className="auth-intro"><p className="eyebrow">Chào bạn quay lại</p><h1>Vào góc làm việc.</h1><p>Một tài khoản chung để đăng nhập Pawket và quản lý bảo mật.</p></div>
      <SignInPanel accountPortalUrl={runtime.accountPortalUrl} mode={session?.leaseRequired && !params.notice ? "lease" : "start"} initialMessage={oidcNotice(params.notice)} returnTo={destination} />
    </div>
  </AppShell>;
}
