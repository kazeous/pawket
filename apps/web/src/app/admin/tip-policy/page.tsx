import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getIdentityRuntime } from "@/auth/runtime";
import { AppShell } from "@/ui/app-shell";
import { OwnerTipPolicyWorkbench } from "./owner-tip-policy-workbench";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Chính sách tip · Pawket", robots: { index: false, follow: false }, referrer: "no-referrer" };
export default async function OwnerTipPolicyPage() {
  const runtime = getIdentityRuntime(); const incoming = await headers();
  const decision = await runtime.authorizeOwner(incoming);
  if (decision === "unauthenticated") redirect("/sign-in");
  if (decision !== "authorized") notFound();
  const actor = await runtime.authenticate(incoming);
  if (!actor) redirect("/sign-in");
  return <AppShell context="Chính sách tip" action={{ href: "/admin/creator-applications", label: "Vận hành creator" }}>
    <section data-tip-surface className="flex min-w-0 flex-col gap-6">
      <header className="workspace-header"><div><p className="eyebrow">Dành cho owner</p><h1>Chính sách tip</h1><p className="lede">Quản lý giới hạn và số tiền gợi ý cho tip mới.</p></div></header>
      <OwnerTipPolicyWorkbench initialActorUserId={actor.userId} />
    </section>
  </AppShell>;
}
