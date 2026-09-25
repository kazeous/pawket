import { loadServerEnv } from "@pawket/config";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getPlatformRuntime } from "@/platform/runtime";
import { AppShell } from "@/ui/app-shell";
import { sepayStatusLabels } from "@/ui/sepay/sepay-client";
import { formatTipTime, isRecord } from "@/ui/tips/tip-client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Tình trạng SePay · Pawket", robots: { index: false, follow: false }, referrer: "no-referrer" };
export default async function AdminSePayPage() {
  const runtime = getPlatformRuntime(); const incoming = new Headers(await headers());
  const access = await runtime.authorizeOwner(incoming); if (access === "unauthenticated") redirect("/sign-in"); if (access !== "authorized") redirect("/");
  const env = loadServerEnv(); let rows: Record<string, unknown>[] | null = null;
  try {
    const response = await runtime.sepayHandlers.diagnostics(new Request(new URL("/api/v1/admin/sepay", env.APP_BASE_URL), { headers: incoming }));
    const value: unknown = await response.json();
    if (!response.ok || !isRecord(value) || !isRecord(value.diagnostics) || !Array.isArray(value.diagnostics.items) || !value.diagnostics.items.every(isRecord)) throw new Error();
    rows = value.diagnostics.items;
  } catch { /* Show a private fixed error instead of provider details. */ }
  return <AppShell context="Tình trạng SePay" action={{ href: "/admin", label: "Trang quản trị" }}><section className="flex min-w-0 flex-col gap-6">
    <header className="workspace-header"><div><p className="eyebrow">Vận hành</p><h1>Tình trạng kết nối SePay</h1><p className="lede">Theo dõi kết nối và các giao dịch cần người bán kiểm tra.</p></div></header>
    {rows === null ? <Alert variant="destructive"><AlertTitle>Chưa tải được tình trạng kết nối</AlertTitle><AlertDescription>Vui lòng tải lại trang.</AlertDescription></Alert> : rows.length === 0 ? <p>Chưa có kết nối SePay.</p> : rows.map((row) => <Card key={String(row.connectionId)}><CardHeader><CardTitle>{String(row.bankName)} · {String(row.maskedSuffix)}</CardTitle><CardDescription>{sepayStatusLabels[String(row.status)] ?? "Chưa rõ trạng thái"}</CardDescription></CardHeader><CardContent className="flex flex-col gap-2">
      <p>Đang chờ: {Number(row.pendingCount)} · Cần kiểm tra: {Number(row.reviewCount)}</p><p>Thông báo gần nhất: {typeof row.lastReceivedAt === "string" ? formatTipTime(row.lastReceivedAt) : "Chưa có"}</p>
      {row.remoteRevocationStatus === "unknown" ? <p>Chưa xác minh việc thu hồi quyền tại SePay.</p> : null}
    </CardContent></Card>)}
  </section></AppShell>;
}
