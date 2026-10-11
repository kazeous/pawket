import { loadServerEnv } from "@pawket/config";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getPlatformRuntime } from "@/platform/runtime";
import { AppShell } from "@/ui/app-shell";
import { StatusBanner } from "@/ui/status-banner";
import { MyCases } from "@/ui/help/my-cases";
import { CommissionSession } from "@/ui/commissions/commission-session";
import { parseCommission, type Role } from "@/ui/commissions/commission-client";
import { myCasesSchema } from "@/ui/resolutions/resolution-client";
import { EnforcementBanner } from "@/ui/trust/enforcement-banner";
import type { TrustMode } from "@/ui/trust/trust-client";

export const dynamic = "force-dynamic";
export default async function MyCasesPage() {
  const incoming = new Headers(await headers()); const platform = getPlatformRuntime(); const env = loadServerEnv();
  const actor = await platform.authenticate(incoming); if (!actor) redirect("/sign-in");
  let initial = null; let trustMode: TrustMode = "disabled"; const orderRoles: Record<string, Role> = {};
  try {
    const response = await platform.resolutionHandlers.myCases(new Request(new URL("/api/v1/help/cases", env.APP_BASE_URL), { headers: incoming }));
    if (!response.ok) throw new Error("Cases unavailable"); const result = parseCommission(myCasesSchema, await response.json());
    const ids = new Set([...result.cases.disputes.map((row) => row.orderId), ...result.cases.refunds.map((row) => row.orderId), ...result.cases.lateClaims.map((row) => row.orderId)]);
    for (const orderId of ids) orderRoles[orderId] = (await platform.commissions.getOrder({ actor, orderId })).role;
    initial = result.cases; trustMode = result.controls?.trustMode ?? "disabled";
  } catch { /* Private content is shown only after all reads and role checks succeed. */ }
  return <AppShell context="Trung tâm trợ giúp" action={{ href: "/help", label: "Chính sách" }}><section className="flex min-w-0 flex-col gap-6"><h1>Yêu cầu của tôi</h1>
    <CommissionSession actorUserId={actor.userId}>{initial ? <div className="flex flex-col gap-5"><EnforcementBanner mode={trustMode} penalties={initial.penalties ?? []} /><MyCases cases={initial} orderRoles={orderRoles} trustMode={trustMode} /></div> : <StatusBanner tone="error">Chưa tải được yêu cầu của bạn. <a href="/help/cases" className="underline">Tải lại trang</a></StatusBanner>}</CommissionSession>
  </section></AppShell>;
}
