import { loadServerEnv } from "@pawket/config";
import { getPlatformRuntime } from "@/platform/runtime";
import { StatusBanner } from "@/ui/status-banner";
import { myCasesSchema } from "../resolutions/resolution-client";
import { parseCommission } from "../commissions/commission-client";
import { EnforcementBanner } from "./enforcement-banner";

export async function PartyWarnings({ incoming }: Readonly<{ incoming: Headers }>) {
  const env = loadServerEnv(); if (env.TRUST_ENFORCEMENT_MODE !== "enabled") return null;
  let view: ReturnType<typeof myCasesSchema.parse> | null = null;
  try {
    const response = await getPlatformRuntime().resolutionHandlers.myCases(new Request(new URL("/api/v1/help/cases", env.APP_BASE_URL), { headers: incoming }));
    if (!response.ok) throw new Error("Warnings unavailable");
    view = parseCommission(myCasesSchema, await response.json());
  } catch { /* A failed private read does not hide a possible warning silently. */ }
  return view ? <EnforcementBanner mode={view.controls?.trustMode ?? "disabled"} penalties={view.cases.penalties ?? []} />
    : <StatusBanner tone="error">Chưa tải được cảnh cáo của bạn. <a href="/help/cases" className="underline">Xem Yêu cầu của tôi</a></StatusBanner>;
}
