import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { getPlatformRuntime } from "../../../../platform/runtime";
import { AppShell } from "../../../../ui/app-shell";
import { CaseDetail } from "../../../../ui/cases/case-detail";
export const dynamic = "force-dynamic";
export default async function CasePage({ params }: { params: Promise<{ caseId: string }> }) {
  const runtime = getPlatformRuntime(); const incoming = await headers(); const permission = await runtime.authorizeOwner(incoming);
  if (permission === "unauthenticated") redirect("/sign-in"); if (permission !== "authorized") notFound();
  const actor = await runtime.authenticate(incoming); if (!actor) redirect("/sign-in");
  const { caseId } = await params; if (!z.uuid().safeParse(caseId).success) notFound();
  return <AppShell context="Owner workspace" action={{ href: "/admin/cases", label: "Hàng đợi vụ việc" }}><header className="workspace-header reveal"><div><p className="eyebrow">Chỉ owner · có nhật ký</p><h1>Chi tiết vụ việc</h1><p className="lede">Kiểm tra bằng chứng, thời hạn và kết quả trước khi xử lý.</p></div></header><CaseDetail caseId={caseId} actorUserId={actor.userId} /></AppShell>;
}
