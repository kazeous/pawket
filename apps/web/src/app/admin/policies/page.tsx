import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getPlatformRuntime } from "../../../platform/runtime";
import { AppShell } from "../../../ui/app-shell";
import { PolicyPublisher } from "../../../ui/trust/policy-publisher";
export const dynamic = "force-dynamic";
export default async function PoliciesPage() {
  const runtime = getPlatformRuntime(); const incoming = await headers(); const permission = await runtime.authorizeOwner(incoming);
  if (permission === "unauthenticated") redirect("/sign-in"); if (permission !== "authorized") notFound();
  const actor = await runtime.authenticate(incoming); if (!actor) redirect("/sign-in");
  return <AppShell context="Owner workspace" action={{ href: "/admin/cases", label: "Hàng đợi vụ việc" }}><header className="workspace-header reveal"><div><p className="eyebrow">Chỉ owner · có nhật ký</p><h1>Chính sách cộng đồng</h1><p className="lede">Xem phiên bản hiện tại và xuất bản quy tắc, chính sách xử lý vi phạm và kháng nghị đã được duyệt.</p></div></header><PolicyPublisher actorUserId={actor.userId} enforcementEnabled={runtime.trustEnforcementMode === "enabled"} /></AppShell>;
}
