import { loadServerEnv } from "@pawket/config";
import type { Metadata } from "next";
import { headers } from "next/headers";

import { getPlatformRuntime } from "@/platform/runtime";
import { resolveTipReceiptPage } from "@/platform/tip-receipt-page";
import { AppShell } from "@/ui/app-shell";
import { TipReceipt } from "@/ui/tips/tip-receipt";
import type { TipReceiptPageState } from "@/ui/tips/tip-client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Phiếu tip · Pawket", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function TipReceiptPage({ params, searchParams }: Readonly<{
  params: Promise<{ reference: string }>; searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { reference } = await params;
  let initial: TipReceiptPageState = { kind: "unavailable", code: "not_available" };
  if (/^PW[0-9A-F]{20}$/u.test(reference) && Object.keys(await searchParams).length === 0) {
    try {
      const runtime = getPlatformRuntime();
      initial = await resolveTipReceiptPage({ reference, headers: new Headers(await headers()), appBaseUrl: loadServerEnv().APP_BASE_URL, handlers: runtime.tipHandlers, authenticate: runtime.authenticate });
    } catch { initial = { kind: "unavailable", code: "dependency_unavailable" }; }
  }
  return <AppShell context="Phiếu tip" width="narrow" action={{ href: "/creators", label: "Khám phá" }}>
    <header className="workspace-header"><div><p className="eyebrow">Tip</p><h1>Phiếu tip của bạn</h1></div></header>
    <TipReceipt reference={/^PW[0-9A-F]{20}$/u.test(reference) ? reference : null} initial={initial} />
  </AppShell>;
}
