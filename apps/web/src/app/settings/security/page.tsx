import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getIdentityRuntime } from "../../../auth/runtime";
import { SecurityPanel } from "./security-panel";
import { AppShell } from "../../../ui/app-shell";

export const dynamic = "force-dynamic";
export default async function SecuritySettingsPage() {
  const runtime = getIdentityRuntime(); const session = await runtime.authenticate(await headers(), true);
  if (!session || session.leaseRequired) redirect("/sign-in?returnTo=/settings/security");
  return <AppShell context="Tài khoản" action={{ href: "/creator/apply", label: "Hồ sơ creator" }}>
    <header className="workspace-header reveal"><div><p className="eyebrow">Tài khoản</p><h1>Bảo mật &amp; đăng nhập</h1><p className="lede">Quản lý tài khoản chung và các phiên truy cập Pawket.</p></div></header>
    <SecurityPanel accountPortalUrl={runtime.accountPortalUrl} mfaStatus={session.mfaStatus} />
  </AppShell>;
}
