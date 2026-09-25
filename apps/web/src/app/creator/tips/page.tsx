import { isTipPaymentsEnabled } from "@pawket/config/increment-four";
import { loadServerEnv } from "@pawket/config";
import type { CreatorTipQueue as Queue, PaymentIntentState } from "@pawket/payments";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { getPlatformRuntime } from "@/platform/runtime";
import { AppShell } from "@/ui/app-shell";
import { CreatorTipQueue } from "@/ui/tips/creator-tip-queue";
import { CreatorTipSettings } from "@/ui/tips/creator-tip-settings";
import { creatorTipErrorText, readCreatorTipQueue, readCreatorTipSettings, tipStateLabels, type CreatorTipSettingsView } from "@/ui/tips/creator-tip-client";
import { isRecord } from "@/ui/tips/tip-client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Quản lý tip · Pawket", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function CreatorTipsPage({ searchParams }: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const runtime = getPlatformRuntime(); const incoming = new Headers(await headers());
  const actor = await runtime.authenticate(incoming);
  if (!actor) redirect("/sign-in");
  const env = loadServerEnv(); const params = await searchParams; const rawState = params.state ?? "awaiting_transfer";
  const validState = typeof rawState === "string" && Object.hasOwn(tipStateLabels, rawState);
  const state: PaymentIntentState = validState ? rawState as PaymentIntentState : "awaiting_transfer";
  const validQuery = validState && Object.keys(params).every((key) => ["state", "cursor"].includes(key)) && (params.cursor === undefined || (typeof params.cursor === "string" && params.cursor.length > 0 && params.cursor.length <= 400));
  let queue: Queue | null = null; let queueError: string | null = validQuery ? null : "Bộ lọc chưa hợp lệ. Chọn lại trạng thái hoặc về trang đầu.";
  let settings: CreatorTipSettingsView | null = null; let settingsError = false;
  const url = new URL("/api/v1/creator/tips", env.APP_BASE_URL); url.searchParams.set("state", state); if (typeof params.cursor === "string" && validQuery) url.searchParams.set("cursor", params.cursor);
  const results = await Promise.allSettled([
    validQuery ? runtime.creatorTipHandlers.queue(new Request(url, { headers: incoming })) : Promise.resolve(null),
    runtime.creatorTipSettingsHandlers.read(new Request(new URL("/api/v1/creator/tip-settings", env.APP_BASE_URL), { headers: incoming })),
  ]);
  const queueResult = results[0];
  if (validQuery) {
    try {
      if (queueResult.status !== "fulfilled" || !queueResult.value) throw new Error();
      const value: unknown = await queueResult.value.json();
      if (queueResult.value.ok) queue = readCreatorTipQueue(value);
      else queueError = creatorTipErrorText(isRecord(value) && typeof value.code === "string" ? value.code : "dependency_unavailable");
    } catch { queueError = "Chưa tải được dữ liệu. Vui lòng thử tải lại danh sách."; }
  }
  try {
    const settingsResult = results[1]; if (settingsResult.status !== "fulfilled" || !settingsResult.value.ok) throw new Error();
    const value: unknown = await settingsResult.value.json();
    if (!isRecord(value)) throw new Error();
    if (value.settings !== null) {
      if (!isRecord(value.settings) || typeof value.settings.available !== "boolean") throw new Error();
      settings = { ...readCreatorTipSettings(value.settings), available: value.settings.available };
    }
  } catch { settingsError = true; }
  const paymentsEnabled = isTipPaymentsEnabled(env.TIP_PAYMENTS_MODE);
  return <AppShell context="Quản lý tip" action={{ href: "/creator", label: "Trang nghệ sĩ" }}>
    <section data-tip-surface className="flex min-w-0 flex-col gap-6"><header className="workspace-header"><div><p className="eyebrow">Tip</p><h1>Quản lý tip của bạn</h1><p className="lede">Cài đặt nhận tip và đối chiếu tiền vào tài khoản ngân hàng của bạn.</p></div></header>
      {settingsError ? <Alert variant="destructive"><AlertTitle>Chưa tải được cài đặt nhận tip</AlertTitle><AlertDescription>Tải lại trang để kiểm tra. Bạn vẫn có thể thử xem danh sách tip bên dưới.</AlertDescription></Alert> : <CreatorTipSettings key={`${settings?.revisionNumber ?? "none"}:${settings?.available}:${paymentsEnabled}`} initial={settings} editable={paymentsEnabled && env.CREATOR_PUBLISHING_MODE === "general_audience"} initialActorUserId={actor.userId} />}
      <a href="/creator/tips/sepay" className="text-sm underline">Quản lý kết nối và đối soát SePay</a>
      <CreatorTipQueue queue={queue} state={state} paymentsEnabled={paymentsEnabled} error={queueError} />
    </section>
  </AppShell>;
}
