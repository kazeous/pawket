import { loadServerEnv } from "@pawket/config";
import { getPlatformRuntime } from "@/platform/runtime";
import { StatusBanner } from "@/ui/status-banner";
import type { MyTrustCasesView } from "./trust-client";
import { EnforcementBanner } from "./enforcement-banner";

export async function PartyWarnings({ incoming, actorUserId }: Readonly<{ incoming: Headers; actorUserId?: string }>) {
  const env = loadServerEnv(); if (env.TRUST_ENFORCEMENT_MODE !== "enabled") return null;
  let view: MyTrustCasesView | null = null;
  try {
    const runtime = getPlatformRuntime();
    const actor = await runtime.authenticate(incoming);
    if (!actor) throw new Error("Warnings unavailable");
    view = await runtime.partyTrust.listForUser(actor.userId);
  } catch { /* A failed private read does not hide a possible warning silently. */ }
  return view ? <EnforcementBanner mode={env.TRUST_ENFORCEMENT_MODE} penalties={view.penalties} actorUserId={actorUserId} />
    : <StatusBanner tone="error">Chưa kiểm tra được thông báo về tài khoản của bạn. <a href="/help/cases" className="underline">Xem Yêu cầu của tôi</a></StatusBanner>;
}
