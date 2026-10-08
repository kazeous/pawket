import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getPlatformRuntime } from "../../../platform/runtime";
import { AppShell } from "../../../ui/app-shell";
import { CaseQueue } from "../../../ui/cases/case-queue";
export const dynamic = "force-dynamic";
export default async function CasesPage() {
  const runtime = getPlatformRuntime(); const incoming = await headers(); const permission = await runtime.authorizeOwner(incoming);
  if (permission === "unauthenticated") redirect("/sign-in"); if (permission !== "authorized") notFound();
  if (!await runtime.authenticate(incoming)) redirect("/sign-in");
  return <AppShell context="Owner workspace" action={{ href: "/admin/creator-applications", label: "Vận hành creator" }}><header className="workspace-header reveal"><div><p className="eyebrow">Chỉ owner · có nhật ký</p><h1>Khiếu nại &amp; hoàn tiền</h1><p className="lede">Xem vụ việc cần xử lý. Bằng chứng riêng tư chỉ được mở khi bạn yêu cầu và xác thực tài khoản.</p></div></header><CaseQueue /></AppShell>;
}
