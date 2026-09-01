import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { getPlatformRuntime } from "../../../platform/runtime";
import { AppShell } from "../../../ui/app-shell";
import { ContentReportWorkbench } from "./content-report-workbench";

export const dynamic = "force-dynamic";

export default async function ContentReportsPage() {
  const decision = await getPlatformRuntime().authorizeOwner(await headers());
  if (decision === "unauthenticated") redirect("/sign-in");
  if (decision !== "authorized") notFound();
  return <AppShell context="Owner workspace" action={{ href: "/admin/creator-applications", label: "Vận hành creator" }}><header className="workspace-header reveal"><div><p className="eyebrow">Owner-only · audited</p><h1>Báo cáo nội dung công khai</h1><p className="lede">Xem snapshot an toàn và xử lý bằng TOTP step-up, version hiện tại, lý do và idempotency key.</p></div></header><ContentReportWorkbench /></AppShell>;
}
