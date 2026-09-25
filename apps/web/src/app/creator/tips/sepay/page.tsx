import { loadServerEnv } from "@pawket/config";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getPlatformRuntime } from "@/platform/runtime";
import { AppShell } from "@/ui/app-shell";
import { CreatorSePay } from "@/ui/sepay/creator-sepay";
import { readSePayQueue, readSePaySnapshot, sepayErrorText } from "@/ui/sepay/sepay-client";
import { isRecord } from "@/ui/tips/tip-client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Đối soát SePay · Pawket", robots: { index: false, follow: false }, referrer: "no-referrer" };
export default async function CreatorSePayPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const runtime = getPlatformRuntime(); const incoming = new Headers(await headers());
  const actor = await runtime.authenticate(incoming); if (!actor) redirect("/sign-in");
  const env = loadServerEnv(); const params = await searchParams;
  let initial = null; let queue = null; let error: string | null = null;
  const results = await Promise.allSettled([
    runtime.sepayHandlers.snapshot(new Request(new URL("/api/v1/creator/tips/sepay", env.APP_BASE_URL), { headers: incoming })),
    runtime.sepayHandlers.reviews(new Request(new URL("/api/v1/creator/tips/sepay/reviews", env.APP_BASE_URL), { headers: incoming })),
  ]);
  try {
    for (const result of results) {
      if (result.status !== "fulfilled") throw new Error();
      if (!result.value.ok) { const value: unknown = await result.value.json(); error = sepayErrorText(isRecord(value) && typeof value.code === "string" ? value.code : "dependency_unavailable"); }
    }
    if (results[0].status === "fulfilled" && results[0].value.ok) initial = readSePaySnapshot(await results[0].value.json());
    if (results[1].status === "fulfilled" && results[1].value.ok) queue = readSePayQueue(await results[1].value.json());
  } catch { error = "Chưa tải được thông tin SePay. Vui lòng thử tải lại."; }
  return <AppShell context="Đối soát SePay" action={{ href: "/creator/tips", label: "Quản lý tip" }}>
    <section className="flex min-w-0 flex-col gap-6"><header className="workspace-header"><div><p className="eyebrow">Tip</p><h1>Đối soát qua SePay</h1><p className="lede">Quản lý kết nối nhận tiền và kiểm tra các giao dịch cần đối chiếu.</p></div></header>
      <CreatorSePay initial={initial} initialQueue={queue} actorUserId={actor.userId} paymentsEnabled={env.TIP_PAYMENTS_MODE !== "disabled"} initialError={error} oauthResult={typeof params.oauth === "string" ? params.oauth : null} />
    </section>
  </AppShell>;
}
