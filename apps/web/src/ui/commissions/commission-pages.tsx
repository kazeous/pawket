import { DISCIPLINES } from "@pawket/catalog";
import { loadServerEnv } from "@pawket/config";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { z } from "zod";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getPlatformRuntime } from "@/platform/runtime";
import { AppShell } from "@/ui/app-shell";
import { formatVnd, isRecord, TipRequestError } from "@/ui/tips/tip-client";
import { commissionErrorText, commissionPath, detailSchema, ordersSchema, parseCommission, publicPackagesSchema, routeLabels, workspaceSchema, type Role } from "./commission-client";
import { CommissionDetail } from "./commission-detail";
import { CommissionList } from "./commission-list";
import { CommissionRequest } from "./commission-request";
import { CommissionSession } from "./commission-session";
import { CommissionTerms } from "./commission-terms";
import { PackageWorkbench } from "./package-workbench";

async function pageContext() {
  const incoming = new Headers(await headers()); const platform = getPlatformRuntime(); const env = loadServerEnv();
  return { platform, env, incoming, request: (path: string) => new Request(new URL(path, env.APP_BASE_URL), { headers: incoming }) };
}
async function read<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const value: unknown = await response.json(); if (!response.ok) throw new TipRequestError(isRecord(value) && typeof value.code === "string" ? value.code : "dependency_unavailable");
  return parseCommission(schema, value);
}
function errorCode(error: unknown) { return error instanceof TipRequestError ? error.code : "dependency_unavailable"; }
function PageFailure({ code, href }: Readonly<{ code: string; href: string }>) {
  return <Alert variant="destructive"><AlertTitle>Chưa tải được nội dung commission</AlertTitle><AlertDescription><p>{commissionErrorText(code)}</p><a href={href} className="underline">Tải lại trang</a></AlertDescription></Alert>;
}
export async function CommissionListPage({ role }: Readonly<{ role: Role }>) {
  const ctx = await pageContext(); const actor = await ctx.platform.authenticate(ctx.incoming); if (!actor) redirect("/sign-in");
  let initial = null; let code = "dependency_unavailable";
  try { initial = await read(await ctx.platform.commissionHandlers.list(ctx.request(`/api/v1${commissionPath(role)}`), role), ordersSchema); } catch (error) { code = errorCode(error); }
  return <AppShell context="Commission" action={{ href: role === "creator" ? "/creator" : "/creators", label: role === "creator" ? "Trang nghệ sĩ" : "Tìm nghệ sĩ" }}><section data-commission-surface className="flex min-w-0 flex-col gap-6"><header><p className="eyebrow">Commission</p><h1>{role === "creator" ? "Yêu cầu và đơn nhận vẽ" : "Commission của bạn"}</h1><p className="lede">Theo dõi yêu cầu, điều khoản và trạng thái thanh toán.</p></header>
    <CommissionSession key={`${actor.userId}:${role}`} actorUserId={actor.userId}>{initial ? <CommissionList initial={initial.orders} role={role} /> : <PageFailure code={code} href={commissionPath(role)} />}</CommissionSession>
  </section></AppShell>;
}
export async function CommissionDetailPage({ role, orderId }: Readonly<{ role: Role; orderId: string }>) {
  const ctx = await pageContext(); const actor = await ctx.platform.authenticate(ctx.incoming); if (!actor) redirect("/sign-in");
  let initial = null; let code = "dependency_unavailable";
  try { initial = await read(await ctx.platform.commissionHandlers.detail(ctx.request(`/api/v1${commissionPath(role)}/${encodeURIComponent(orderId)}`), orderId, role), detailSchema); } catch (error) { code = errorCode(error); }
  if (!initial && code === "not_available") notFound();
  return <AppShell context="Commission" action={{ href: commissionPath(role), label: "Danh sách commission" }}><section data-commission-surface className="min-w-0"><CommissionSession key={`${actor.userId}:${orderId}`} actorUserId={actor.userId}>
    {initial ? <CommissionDetail initial={initial} /> : <><h1>Chi tiết commission</h1><PageFailure code={code} href={`${commissionPath(role)}/${encodeURIComponent(orderId)}`} /></>}
  </CommissionSession></section></AppShell>;
}
export async function CommissionPackagesPage() {
  const ctx = await pageContext(); const actor = await ctx.platform.authenticate(ctx.incoming); if (!actor) redirect("/sign-in");
  let initial = null; let code = "dependency_unavailable";
  try { initial = await read(await ctx.platform.commissionHandlers.workspace(ctx.request("/api/v1/creator/commissions/packages")), workspaceSchema); } catch (error) { code = errorCode(error); }
  if (!initial && code === "not_available") notFound();
  return <AppShell context="Gói commission" action={{ href: "/creator/commissions", label: "Yêu cầu và đơn" }}><section data-commission-surface className="flex min-w-0 flex-col gap-6"><header><p className="eyebrow">Góc nghệ sĩ</p><h1>Gói commission và suất nhận việc</h1><p className="lede">Chuẩn bị gói, điều khoản và cách bạn nhận yêu cầu.</p></header><CommissionSession key={actor.userId} actorUserId={actor.userId}>
    {initial ? <PackageWorkbench initial={initial} disciplines={DISCIPLINES} /> : <PageFailure code={code} href="/creator/commissions/packages" />}
  </CommissionSession></section></AppShell>;
}
export async function PublicCommissionPackages({ handle }: Readonly<{ handle: string }>) {
  if (loadServerEnv().COMMISSION_INTAKE_MODE !== "enabled") return null;
  const ctx = await pageContext(); let result;
  try { result = await read(await ctx.platform.commissionHandlers.publicPackages(ctx.request(`/api/v1/public/creators/${encodeURIComponent(handle)}/commissions`), handle), publicPackagesSchema); }
  catch { return <Alert><AlertTitle>Chưa tải được gói commission</AlertTitle><AlertDescription>Vui lòng quay lại sau để xem các gói nhận việc.</AlertDescription></Alert>; }
  if (!result.packages.length) return null;
  return <section data-commission-surface className="flex min-w-0 flex-col gap-4" aria-label="Gói commission"><h2>Commission</h2><div className="grid min-w-0 gap-4 md:grid-cols-2">{result.packages.map((p) => <Card key={p.id}><CardHeader><CardTitle role="heading" aria-level={3} className="wrap-anywhere"><a href={`/creators/${handle}/commissions/${p.id}`} className="underline underline-offset-4">{p.title}</a></CardTitle><CardDescription>{routeLabels[p.route]}</CardDescription></CardHeader><CardContent className="flex flex-col gap-2"><p>{p.terms ? formatVnd(p.terms.amountVnd) : "Giá theo brief"}</p><p className="text-sm text-muted-foreground">{!p.accepting ? "Tạm dừng nhận yêu cầu" : p.capacityAvailable ? "Đang nhận yêu cầu" : p.route === "fixed_immediate" ? "Đã hết suất" : "Nhận yêu cầu · chưa giữ suất"}</p></CardContent></Card>)}</div></section>;
}
export async function PublicCommissionPackagePage({ handle, packageId }: Readonly<{ handle: string; packageId: string }>) {
  const ctx = await pageContext(); let result;
  try { result = await read(await ctx.platform.commissionHandlers.publicPackages(ctx.request(`/api/v1/public/creators/${encodeURIComponent(handle)}/commissions`), handle), publicPackagesSchema); }
  catch { return <AppShell context="Commission"><h1>Gói commission</h1><PageFailure code="dependency_unavailable" href={`/creators/${encodeURIComponent(handle)}/commissions/${encodeURIComponent(packageId)}`} /></AppShell>; }
  const offering = result.packages.find((p) => p.id === packageId); if (!offering) notFound();
  const actor = await ctx.platform.authenticate(ctx.incoming);
  return <AppShell context={`@${handle}`} action={{ href: `/creators/${handle}`, label: "Trang nghệ sĩ" }}><article data-commission-surface className="flex min-w-0 flex-col gap-6"><header className="flex min-w-0 flex-col gap-3"><p className="eyebrow">{routeLabels[offering.route]}</p><h1 className="wrap-anywhere">{offering.title}</h1><p className="lede whitespace-pre-wrap wrap-anywhere">{offering.description}</p></header>
    <Card><CardHeader><CardTitle role="heading" aria-level={2}>Nội dung và điều khoản</CardTitle><CardDescription>Đọc kỹ nội dung trước khi gửi brief.</CardDescription></CardHeader><CardContent><CommissionTerms terms={offering.terms} policy={offering.policy?.document} /></CardContent></Card>
    {offering.showcaseId ? <a href={`/creators/${handle}#showcase-${offering.showcaseId}`} className="underline">Xem tác phẩm tham khảo</a> : null}
    {actor ? <CommissionSession key={`${actor.userId}:${offering.revisionId}`} actorUserId={actor.userId}><CommissionRequest offering={offering} /></CommissionSession> : <Alert><AlertTitle>Đăng nhập để đặt commission</AlertTitle><AlertDescription><p>Dùng tài khoản đã xác minh email để gửi brief và theo dõi đơn riêng tư.</p><a href="/sign-in" className={buttonVariants({ variant: "outline" })}>Đăng nhập</a></AlertDescription></Alert>}
    <Link prefetch={false} href="/commissions" className="text-sm underline">Xem commission của bạn</Link>
  </article></AppShell>;
}
