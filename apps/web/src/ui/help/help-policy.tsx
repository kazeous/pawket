import type { CommissionPolicySnapshot } from "@pawket/orders";
import type { TrustPolicyKind, TrustPolicySnapshot } from "@pawket/trust";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getPlatformRuntime } from "@/platform/runtime";
import { StatusBanner } from "@/ui/status-banner";

export function HelpPolicy({ policy, unavailable = false }: Readonly<{ policy: CommissionPolicySnapshot | null; unavailable?: boolean }>) {
  return <Card><CardHeader><CardTitle role="heading" aria-level={2}>Chính sách commission và hoàn tiền</CardTitle><CardDescription>Chính sách commission hiện hành.</CardDescription></CardHeader><CardContent>
    {policy?.document && policy.acceptsOrders ? <><p className="text-sm text-muted-foreground">Phiên bản {policy.revisionNumber}</p><p className="whitespace-pre-wrap wrap-anywhere">{policy.document}</p></>
      : <StatusBanner>{unavailable ? "Chưa tải được chính sách. Vui lòng tải lại trang." : "Chưa được công bố"}</StatusBanner>}
  </CardContent></Card>;
}
export const trustPolicyTitles = { community_rules: "Quy định cộng đồng", enforcement_appeals: "Chính sách xử lý vi phạm và kháng nghị" };
export function TrustHelpPolicy({ kind, policy, unavailable = false }: Readonly<{ kind: TrustPolicyKind; policy: TrustPolicySnapshot | null; unavailable?: boolean }>) {
  return <Card><CardHeader><CardTitle role="heading" aria-level={2}>{trustPolicyTitles[kind]}</CardTitle><CardDescription>Chính sách của Pawket.</CardDescription></CardHeader><CardContent>
    {policy ? <><p className="text-sm text-muted-foreground">Phiên bản {policy.revisionNumber}</p><p className="whitespace-pre-wrap wrap-anywhere">{policy.document}</p></>
      : <StatusBanner>{unavailable ? "Chưa tải được chính sách. Vui lòng tải lại trang." : "Chưa được công bố"}</StatusBanner>}
  </CardContent></Card>;
}
export async function CurrentHelpPolicy() {
  const [commission, community, enforcement] = await Promise.allSettled([
    Promise.resolve().then(() => getPlatformRuntime().readCurrentCommissionPolicy()),
    Promise.resolve().then(() => getPlatformRuntime().trustPolicies.readCurrent("community_rules")),
    Promise.resolve().then(() => getPlatformRuntime().trustPolicies.readCurrent("enforcement_appeals")),
  ]);
  return <><HelpPolicy policy={commission.status === "fulfilled" ? commission.value : null} unavailable={commission.status === "rejected"} />
    <TrustHelpPolicy kind="community_rules" policy={community.status === "fulfilled" ? community.value : null} unavailable={community.status === "rejected"} />
    <TrustHelpPolicy kind="enforcement_appeals" policy={enforcement.status === "fulfilled" ? enforcement.value : null} unavailable={enforcement.status === "rejected"} /></>;
}
