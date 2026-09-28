import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { getPlatformRuntime } from "../../../platform/runtime";
import { AppShell } from "../../../ui/app-shell";
import { ContentReportWorkbench } from "./content-report-workbench";

export const dynamic = "force-dynamic";

export default async function ContentReportsPage() {
  const runtime = getPlatformRuntime(); const incoming = await headers();
  const decision = await runtime.authorizeOwner(incoming);
  if (decision === "unauthenticated") redirect("/sign-in");
  if (decision !== "authorized") notFound();
  const actor = await runtime.authenticate(incoming);
  if (!actor) redirect("/sign-in");
  return <AppShell context="Owner workspace" action={{ href: "/admin/creator-applications", label: "Vận hành creator" }}><header className="workspace-header reveal"><div><p className="eyebrow">Owner-only · audited</p><h1>Báo cáo nội dung công khai</h1><p className="lede">Xem báo cáo và xác nhận danh tính qua tài khoản chung trước khi xử lý.</p></div></header><ContentReportWorkbench initialActorUserId={actor.userId} /></AppShell>;
}
