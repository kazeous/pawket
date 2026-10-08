import type { CommissionPolicySnapshot } from "@pawket/orders";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getPlatformRuntime } from "@/platform/runtime";
import { StatusBanner } from "@/ui/status-banner";

export function HelpPolicy({ policy, unavailable = false }: Readonly<{ policy: CommissionPolicySnapshot | null; unavailable?: boolean }>) {
  return <Card><CardHeader><CardTitle role="heading" aria-level={2}>Chính sách</CardTitle><CardDescription>Chính sách commission hiện hành.</CardDescription></CardHeader><CardContent>
    {policy?.document && policy.acceptsOrders ? <><p className="text-sm text-muted-foreground">Phiên bản {policy.revisionNumber}</p><p className="whitespace-pre-wrap wrap-anywhere">{policy.document}</p></>
      : <StatusBanner>{unavailable ? "Chưa tải được chính sách. Vui lòng tải lại trang." : "Chính sách commission hiện chưa được công bố."}</StatusBanner>}
  </CardContent></Card>;
}
export async function CurrentHelpPolicy() {
  let policy: CommissionPolicySnapshot | null = null; let unavailable = false;
  try { policy = await getPlatformRuntime().readCurrentCommissionPolicy(); }
  catch { unavailable = true; }
  return <HelpPolicy policy={policy} unavailable={unavailable} />;
}
