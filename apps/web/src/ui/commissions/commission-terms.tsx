"use client";

import { useId } from "react";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { formatVnd } from "@/ui/tips/tip-client";
import type { TermsView } from "./commission-client";

const textFields = [["scope", "Phạm vi công việc"], ["deliverables", "Sản phẩm bàn giao"], ["usageRights", "Quyền sử dụng"], ["artistTerms", "Điều khoản của nghệ sĩ"]] as const;
export function CommissionTerms({ terms, policy }: Readonly<{ terms: TermsView | null; policy?: string | null }>) {
  return <div className="flex min-w-0 flex-col gap-5">
    {terms ? <><dl className="grid gap-3 sm:grid-cols-2">{[["Giá trọn gói", formatVnd(terms.amountVnd)], ["Thời gian thực hiện", `${terms.turnaroundDays} ngày từ khi xác nhận tiền`], ["Số vòng chỉnh sửa", String(terms.revisionAllowance)], ["Thời gian xem xét", `${terms.reviewWindowDays} ngày`]].map(([label, value]) => <div key={label}><dt className="text-sm text-muted-foreground">{label}</dt><dd className="font-medium">{value}</dd></div>)}</dl>
      {textFields.map(([key, label]) => <section key={key} className="min-w-0"><h3 className="font-semibold">{label}</h3><p className="whitespace-pre-wrap wrap-anywhere text-sm">{terms[key]}</p></section>)}</> : <p>Nghệ sĩ sẽ báo giá và điều khoản riêng sau khi đọc brief.</p>}
    {policy ? <section><h3 className="font-semibold">Chính sách áp dụng</h3><p className="whitespace-pre-wrap wrap-anywhere text-sm">{policy}</p></section> : null}
  </div>;
}
export function Acceptance({ checked, onChange, disabled, label = "Tôi đã đọc và đồng ý với điều khoản cùng chính sách hiển thị ở trên." }: Readonly<{ checked: boolean; onChange(value: boolean): void; disabled?: boolean; label?: string }>) {
  const id = useId(); return <Field orientation="horizontal" data-disabled={disabled || undefined}><Checkbox id={id} checked={checked} onCheckedChange={(value) => onChange(value === true)} disabled={disabled} /><FieldLabel htmlFor={id} className="font-normal">{label}</FieldLabel></Field>;
}
export function TermsFields({ initial }: Readonly<{ initial?: TermsView | null }>) {
  const id = useId();
  return <FieldGroup>
    <div className="grid gap-4 sm:grid-cols-2">{[["amountVnd", "Giá trọn gói (VND)", 50_000, 50_000_000, initial?.amountVnd ?? ""], ["turnaroundDays", "Số ngày thực hiện", 1, 90, initial?.turnaroundDays ?? 7], ["revisionAllowance", "Số vòng chỉnh sửa", 0, 10, initial?.revisionAllowance ?? 1], ["reviewWindowDays", "Số ngày xem xét", 3, 14, initial?.reviewWindowDays ?? 7]].map(([name, label, min, max, value]) => <Field key={name}><FieldLabel htmlFor={`${id}-${name}`}>{label}</FieldLabel><Input id={`${id}-${name}`} name={String(name)} type="number" min={Number(min)} max={Number(max)} step={1} defaultValue={value} required /></Field>)}</div>
    {textFields.map(([key, label]) => <Field key={key}><FieldLabel htmlFor={`${id}-${key}`}>{label}</FieldLabel><Textarea id={`${id}-${key}`} name={key} rows={3} defaultValue={initial?.[key] ?? ""} required maxLength={4000} aria-describedby={`${id}-${key}-help`} /><FieldDescription id={`${id}-${key}-help`}>Tối đa 2.000 ký tự.</FieldDescription></Field>)}
  </FieldGroup>;
}
export function termsFromForm(form: FormData, policyRevisionId: string): TermsView {
  const field = (name: string) => String(form.get(name) ?? "").trim();
  return { amountVnd: Number(field("amountVnd")), turnaroundDays: Number(field("turnaroundDays")), revisionAllowance: Number(field("revisionAllowance")), reviewWindowDays: Number(field("reviewWindowDays")),
    scope: field("scope"), deliverables: field("deliverables"), usageRights: field("usageRights"), artistTerms: field("artistTerms"), policyRevisionId };
}
