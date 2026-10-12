import { getPlatformRuntime } from "@/platform/runtime";
import { ExpiredHelpLink, LockedHelpShell } from "@/ui/trust/locked-help-shell";
import { LockedResend } from "@/ui/trust/locked-resend";

export const dynamic = "force-dynamic";
export default function LockedResendPage() {
  let enabled = false;
  try { enabled = getPlatformRuntime().trustEnforcementMode === "enabled"; } catch { /* Fail closed. */ }
  return <LockedHelpShell title="Yêu cầu liên kết mới">{enabled ? <LockedResend /> : <ExpiredHelpLink allowResend={false} />}</LockedHelpShell>;
}
