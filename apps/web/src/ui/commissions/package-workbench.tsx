"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { z } from "zod";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { Acceptance, CommissionTerms, TermsFields, termsFromForm } from "./commission-terms";
import { commissionRead, draftSchema, parseCommission, routeLabels, workspaceSchema, type PackageDraft, type WorkspaceView } from "./commission-client";
import { CommandFeedback, useCommissionCommand, useCommissionSession } from "./commission-session";

const base = "/api/v1/creator/commissions";
const packageResult = z.object({ packageId: z.uuid() });
export function PackageWorkbench({ initial, disciplines }: Readonly<{ initial: WorkspaceView; disciplines: readonly string[] }>) {
  const [view, setView] = useState(initial); const [selected, setSelected] = useState<string | null>(null); const [refreshError, setRefreshError] = useState(false);
  const [notice, setNotice] = useState(""); const command = useCommissionCommand(); const verify = useCommissionSession();
  const [refreshing, setRefreshing] = useState(false);
  const w = view.workspace; const chosen = w.packages.find((p) => p.id === selected) ?? null;
  async function reload(id?: string) {
    setRefreshing(true);
    try { await verify(); const next = await commissionRead(`${base}/packages`, workspaceSchema); await verify(); setView(next); if (id) setSelected(id); setRefreshError(false); }
    catch { setRefreshError(true); } finally { setRefreshing(false); }
  }
  function savePackage(payload: { draft: PackageDraft; packageId: string | null; expectedVersion: number }) {
    command.execute(`${base}/packages`, { ...payload, pageId: w.pageId }, (value) => {
      const result = parseCommission(packageResult, value); setNotice("Đã lưu bản nháp. Xuất bản để áp dụng cho yêu cầu mới."); void reload(result.packageId);
    });
  }
  function change(action: "publish" | "pause" | "archive") {
    if (!chosen || !w.policy) return;
    command.execute(`${base}/packages/change`, { packageId: chosen.id, expectedVersion: chosen.version, action, policyRevisionId: w.policy.revisionId }, (value) => {
      parseCommission(packageResult, value); setNotice(action === "publish" ? "Đã xuất bản gói." : action === "pause" ? "Đã tạm ngừng nhận yêu cầu mới cho gói." : "Đã lưu trữ gói. Lịch sử đơn vẫn được giữ.");
      if (action === "archive") setSelected(null); void reload();
    });
  }
  return <div className="flex min-w-0 flex-col gap-6">
    {view.controls.intakeMode === "disabled" || view.controls.paymentsMode === "disabled" ? <Alert><AlertTitle>Commission đang có giới hạn hoạt động</AlertTitle><AlertDescription>{view.controls.intakeMode === "disabled" ? "Hệ thống đang tạm đóng nhận yêu cầu mới. " : ""}{view.controls.paymentsMode === "disabled" ? "Thanh toán đang tạm dừng. " : ""}Bạn vẫn có thể chuẩn bị bản nháp và đọc lịch sử.</AlertDescription></Alert> : null}
    <CommandFeedback command={command} />{notice ? <p role="status">{notice}</p> : null}
    {refreshError ? <Alert><AlertTitle>Đã gửi thao tác nhưng chưa tải được trạng thái mới</AlertTitle><AlertDescription>Kiểm tra lại trước khi sửa tiếp.<Button variant="outline" onClick={() => void reload()}>Tải lại cài đặt</Button></AlertDescription></Alert> : null}
    <CapacitySettings key={w.settings.version} initial={w.settings} disabled={command.locked || refreshError || refreshing} onSave={(enabled, capacityLimit) => command.execute(`${base}/settings`, { expectedVersion: w.settings.version, enabled, capacityLimit }, (value) => { parseCommission(z.object({ saved: z.literal(true) }), value); setNotice("Đã lưu cài đặt nhận commission."); void reload(); })} />
    {!w.pageId ? <Alert><AlertTitle>Cần chuẩn bị trang nghệ sĩ</AlertTitle><AlertDescription><a href="/creator" className="underline">Mở trang nghệ sĩ</a> để tạo hồ sơ trước khi lưu gói.</AlertDescription></Alert> : <div className="grid min-w-0 gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <section aria-label="Danh sách gói" className="flex min-w-0 flex-col gap-3"><div className="flex items-center justify-between gap-3"><h2 className="font-semibold">Gói của bạn ({w.packages.length}/12)</h2><Button variant="outline" size="sm" disabled={command.locked || w.packages.length >= 12} onClick={() => setSelected(null)}>Gói mới</Button></div>
        {w.packages.length === 0 ? <Empty><EmptyHeader><EmptyTitle>Chưa có gói</EmptyTitle><EmptyDescription>Chuẩn bị nội dung gói đầu tiên ở biểu mẫu bên cạnh.</EmptyDescription></EmptyHeader></Empty> : w.packages.map((p) => <Button key={p.id} variant={p.id === selected ? "secondary" : "outline"} className="h-auto justify-start whitespace-normal py-3 text-left" disabled={command.locked} onClick={() => setSelected(p.id)}><span className="flex min-w-0 flex-col gap-1"><span className="wrap-anywhere">{p.draft.title}</span><span className="text-xs text-muted-foreground">{p.state === "open" ? "Đã xuất bản" : p.state === "paused" ? "Tạm dừng" : "Bản nháp"}</span></span></Button>)}
      </section>
      <PackageEditor key={`${chosen?.id ?? "new"}:${chosen?.version ?? 0}`} chosen={chosen} policy={w.policy} showcases={w.showcases} disciplines={disciplines} disabled={command.locked || refreshError || refreshing || (!chosen && w.packages.length >= 12)} onSave={savePackage} onChange={change} />
    </div>}
  </div>;
}
function CapacitySettings({ initial, disabled, onSave }: Readonly<{ initial: WorkspaceView["workspace"]["settings"]; disabled: boolean; onSave(enabled: boolean, limit: number): void }>) {
  const [enabled, setEnabled] = useState(initial.enabled); const id = useId();
  return <Card><CardHeader><CardTitle role="heading" aria-level={2}>Nhận commission</CardTitle><CardDescription>Đang giữ hoặc sử dụng {initial.used}/{initial.capacityLimit} suất. Suất được giữ khi cấp hướng dẫn thanh toán.</CardDescription></CardHeader><CardContent>
    <form onSubmit={(e) => { e.preventDefault(); onSave(enabled, Number(new FormData(e.currentTarget).get("capacity"))); }}><FieldSet disabled={disabled}>
      <Acceptance checked={enabled} onChange={setEnabled} disabled={disabled} label="Mở nhận yêu cầu commission mới" />
      <Field><FieldLabel htmlFor={`${id}-capacity`}>Giới hạn suất nhận việc</FieldLabel><Input id={`${id}-capacity`} name="capacity" type="number" min={1} max={20} step={1} defaultValue={initial.capacityLimit} required /><FieldDescription>1–20 suất. Hạ giới hạn không hủy đơn đang có; hệ thống sẽ chặn cấp suất mới khi đã đầy.</FieldDescription></Field>
      <Button type="submit" className="self-start">Lưu cài đặt</Button>
    </FieldSet></form>
  </CardContent><CardFooter><a href="/creator/tips" className="text-sm underline">Quản lý tài khoản nhận tiền</a></CardFooter></Card>;
}
function PackageEditor({ chosen, policy, showcases, disciplines, disabled, onSave, onChange }: Readonly<{
  chosen: WorkspaceView["workspace"]["packages"][number] | null; policy: WorkspaceView["workspace"]["policy"]; showcases: WorkspaceView["workspace"]["showcases"];
  disciplines: readonly string[]; disabled: boolean;
  onSave(payload: { draft: PackageDraft; packageId: string | null; expectedVersion: number }): void; onChange(action: "publish" | "pause" | "archive"): void;
}>) {
  const id = useId(); const form = useRef<HTMLFormElement>(null); const [route, setRoute] = useState<PackageDraft["route"]>(chosen?.draft.route ?? "fixed_approval");
  const [preview, setPreview] = useState<PackageDraft | null>(null); const [invalid, setInvalid] = useState(false); const [archive, setArchive] = useState(false);
  function read(): PackageDraft | null {
    if (!form.current?.reportValidity()) return null;
    const data = new FormData(form.current); const field = (name: string) => String(data.get(name) ?? "").trim();
    const parsed = draftSchema.safeParse({ title: field("title"), description: field("description"), discipline: field("discipline"), briefInstructions: field("briefInstructions"),
      route, terms: route === "custom_quote" ? null : termsFromForm(data, policy?.revisionId ?? ""), showcaseId: field("showcaseId") || null });
    if (!parsed.success || [...field("title")].length > 100) { setInvalid(true); return null; } setInvalid(false); return parsed.data;
  }
  function save(e: FormEvent) { e.preventDefault(); const draft = read(); if (draft) onSave({ draft, packageId: chosen?.id ?? null, expectedVersion: chosen?.version ?? 0 }); }
  return <Card className="min-w-0"><CardHeader><CardTitle role="heading" aria-level={2}>{chosen ? "Chỉnh sửa gói" : "Tạo gói commission"}</CardTitle><CardDescription>Bản nháp được lưu riêng. Xuất bản áp dụng bản đã lưu cho yêu cầu mới; đơn cũ giữ điều khoản đã nhận.</CardDescription></CardHeader><CardContent className="flex min-w-0 flex-col gap-5">
    <form ref={form} onSubmit={save}><FieldSet disabled={disabled}><FieldGroup>
      <Field><FieldLabel htmlFor={`${id}-title`}>Tên gói</FieldLabel><Input id={`${id}-title`} name="title" defaultValue={chosen?.draft.title ?? ""} maxLength={200} required /><FieldDescription>Tối đa 100 ký tự.</FieldDescription></Field>
      <Field><FieldLabel htmlFor={`${id}-discipline`}>Chuyên ngành</FieldLabel><NativeSelect id={`${id}-discipline`} name="discipline" defaultValue={chosen?.draft.discipline ?? "illustration"}>{disciplines.map((d) => <NativeSelectOption key={d} value={d}>{d}</NativeSelectOption>)}</NativeSelect></Field>
      <Field><FieldLabel htmlFor={`${id}-route`}>Cách nhận yêu cầu</FieldLabel><NativeSelect id={`${id}-route`} value={route} onChange={(e) => setRoute(e.target.value as PackageDraft["route"])}>{Object.entries(routeLabels).map(([key, label]) => <NativeSelectOption key={key} value={key}>{label}</NativeSelectOption>)}</NativeSelect></Field>
      {[["description", "Mô tả gói"], ["briefInstructions", "Hướng dẫn viết brief"]].map(([key, label]) => <Field key={key}><FieldLabel htmlFor={`${id}-${key}`}>{label}</FieldLabel><Textarea id={`${id}-${key}`} name={key} defaultValue={chosen?.draft[key as "description" | "briefInstructions"] ?? ""} rows={3} maxLength={4000} /><FieldDescription>Tối đa 2.000 ký tự.</FieldDescription></Field>)}
      <Field><FieldLabel htmlFor={`${id}-showcase`}>Tác phẩm tham khảo trên trang của bạn</FieldLabel><NativeSelect id={`${id}-showcase`} name="showcaseId" defaultValue={chosen?.draft.showcaseId ?? ""}><NativeSelectOption value="">Không gắn tác phẩm</NativeSelectOption>{chosen?.draft.showcaseId && !showcases.some((s) => s.id === chosen.draft.showcaseId) ? <NativeSelectOption value={chosen.draft.showcaseId}>Tác phẩm đã ẩn — chọn lại trước khi xuất bản</NativeSelectOption> : null}{showcases.map((s) => <NativeSelectOption key={s.id} value={s.id}>{s.title}</NativeSelectOption>)}</NativeSelect></Field>
      {route !== "custom_quote" ? <TermsFields initial={chosen?.draft.terms} /> : <p className="text-sm text-muted-foreground">Bạn sẽ gửi giá và điều khoản cụ thể trong từng yêu cầu.</p>}
      {invalid ? <Alert variant="destructive"><AlertTitle>Kiểm tra nội dung gói</AlertTitle><AlertDescription>Điền đúng giới hạn số tiền, thời hạn và độ dài các trường.</AlertDescription></Alert> : null}
      <div className="flex flex-wrap gap-2"><Button type="submit">Lưu bản nháp</Button><Button type="button" variant="outline" onClick={() => { const draft = read(); if (draft) setPreview(draft); }}>Xem trước</Button></div>
    </FieldGroup></FieldSet></form>
    {preview ? <section aria-label="Xem trước gói" className="flex min-w-0 flex-col gap-4"><Badge variant="outline">Xem trước riêng tư</Badge><h3 className="text-xl font-semibold wrap-anywhere">{preview.title}</h3><p className="whitespace-pre-wrap wrap-anywhere">{preview.description}</p><p>{routeLabels[preview.route]}</p><CommissionTerms terms={preview.terms} policy={policy?.document} /><Button variant="outline" onClick={() => setPreview(null)}>Đóng xem trước</Button></section> : null}
    {chosen ? <div className="flex flex-col gap-3"><p className="text-sm text-muted-foreground">Xuất bản dùng bản nháp đã lưu gần nhất.</p><div className="flex flex-wrap gap-2"><Button disabled={disabled || !policy?.acceptsOrders} onClick={() => onChange("publish")}>Xuất bản bản đã lưu</Button>{chosen.state === "open" ? <Button disabled={disabled} variant="outline" onClick={() => onChange("pause")}>Tạm dừng gói</Button> : null}<Button disabled={disabled} variant="outline" onClick={() => setArchive(true)}>Lưu trữ gói</Button></div>
      {archive ? <Alert><AlertTitle>Lưu trữ gói này?</AlertTitle><AlertDescription><p>Gói sẽ ngừng nhận và chốt yêu cầu mới. Các đơn đã tạo và lịch sử vẫn được giữ.</p><div className="flex flex-wrap gap-2"><Button disabled={disabled} onClick={() => onChange("archive")}>Đồng ý lưu trữ</Button><Button disabled={disabled} variant="outline" onClick={() => setArchive(false)}>Giữ gói</Button></div></AlertDescription></Alert> : null}
      {!policy?.acceptsOrders ? <p className="text-sm">Chính sách nhận đơn chưa sẵn sàng. Bạn có thể tiếp tục lưu bản nháp.</p> : null}
    </div> : null}
  </CardContent><CardFooter><Link prefetch={false} href="/creator/commissions" className={buttonVariants({ variant: "outline" })}>Xem yêu cầu và đơn</Link></CardFooter></Card>;
}
