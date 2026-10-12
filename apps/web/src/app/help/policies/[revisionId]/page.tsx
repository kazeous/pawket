import type { TrustPolicySnapshot } from "@pawket/trust";
import { getPlatformRuntime } from "@/platform/runtime";
import { TrustHelpPolicy, trustPolicyTitles } from "@/ui/help/help-policy";
import { LockedHelpShell } from "@/ui/trust/locked-help-shell";
import { StatusBanner } from "@/ui/status-banner";

export const dynamic = "force-dynamic";
export default async function PolicyVersionPage({ params }: Readonly<{ params: Promise<{ revisionId: string }> }>) {
  const { revisionId } = await params; let policy: TrustPolicySnapshot | null = null; let unavailable = false;
  try { policy = await getPlatformRuntime().trustPolicies.readRevision(revisionId); } catch { unavailable = true; }
  return <LockedHelpShell title={policy ? trustPolicyTitles[policy.kind] : "Chính sách"}>
    {policy ? <TrustHelpPolicy kind={policy.kind} policy={policy} /> : <StatusBanner>{unavailable ? "Chưa tải được chính sách. Vui lòng tải lại trang." : "Chưa được công bố"}</StatusBanner>}
  </LockedHelpShell>;
}
