import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { getIdentityRuntime } from "../../../auth/runtime";
import { AppShell } from "../../../ui/app-shell";
import { OwnerWorkbench } from "./owner-workbench";

export const dynamic = "force-dynamic";

export default async function CreatorApplicationsAdminPage() {
  const decision = await getIdentityRuntime().authorizeOwner(await headers());
  if (decision === "unauthenticated") redirect("/sign-in");
  if (decision !== "authorized") notFound();

  return (
    <AppShell context="Owner workspace" action={{ href: "/settings/security", label: "Bảo mật" }}>
      <header className="workspace-header reveal"><div><p className="eyebrow">Owner-only</p><h1>Vận hành creator</h1><p className="lede">Xét duyệt hồ sơ, đối soát khoản xác minh và quản lý quyền creator trong một workspace có audit.</p></div></header>
      <OwnerWorkbench />
    </AppShell>
  );
}
