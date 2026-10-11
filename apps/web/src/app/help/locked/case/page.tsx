import { cookies } from "next/headers";
import type { HelpCaseView } from "@pawket/trust";
import { getPlatformRuntime } from "@/platform/runtime";
import { LockedCase } from "@/ui/trust/locked-case";
import { ExpiredHelpLink, LockedHelpShell } from "@/ui/trust/locked-help-shell";

export const dynamic = "force-dynamic";
export default async function LockedCasePage() {
  const helpCookies = (await cookies()).getAll("pawket_help"); let view: HelpCaseView | null = null;
  if (helpCookies.length === 1 && /^[A-Za-z0-9_-]{43}$/u.test(helpCookies[0]!.value)) {
    try { const runtime = getPlatformRuntime(); if (runtime.trustEnforcementMode === "enabled") view = await runtime.helpCases.read(helpCookies[0]!.value); }
    catch { /* Invalid links and unavailable private reads have the same public state. */ }
  }
  return <LockedHelpShell title="Thông báo về tài khoản">{view ? <LockedCase view={view} /> : <ExpiredHelpLink />}</LockedHelpShell>;
}
