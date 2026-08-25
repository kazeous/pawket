import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { SignInPanel } from "./sign-in-panel";
import { getIdentityRuntime } from "../../auth/runtime";
import { authenticatedEntryRedirect, resolvePublicSession } from "../../auth/public-session";
import { socialAuthGuidance } from "../../auth/social-auth-guidance";
import { AppShell } from "../../ui/app-shell";

export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const runtime = getIdentityRuntime();
  const params = await searchParams;
  const destination = authenticatedEntryRedirect(
    await resolvePublicSession(runtime.authenticate, await headers()),
  );
  if (destination) redirect(destination);

  return (
    <AppShell width="narrow" action={{ href: "/register", label: "Tạo tài khoản" }} context="Tài khoản">
      <div className="auth-layout reveal">
        <div className="auth-intro"><p className="eyebrow">Chào bạn quay lại</p><h1>Vào góc làm việc.</h1><p>Quản lý bảo mật và hồ sơ creator trong một không gian riêng tư, rõ ràng.</p></div>
        <SignInPanel enabledProviders={runtime.auth.enabledProviders} initialMessage={socialAuthGuidance(params.error)} />
      </div>
    </AppShell>
  );
}
