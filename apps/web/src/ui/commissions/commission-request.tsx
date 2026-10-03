"use client";

import { useCallback, useId, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldSet } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { ReferenceFilePicker } from "./reference-files";
import { Acceptance } from "./commission-terms";
import { orderResultSchema, parseCommission, type PublicPackage } from "./commission-client";
import { CommandFeedback, useCommissionCommand } from "./commission-session";

export function CommissionRequest({ offering }: Readonly<{ offering: PublicPackage }>) {
  const id = useId(); const firstField = useRef<HTMLTextAreaElement>(null); const command = useCommissionCommand(); const router = useRouter();
  const [accepted, setAccepted] = useState(false); const [invalid, setInvalid] = useState(false); const [created, setCreated] = useState(false);
  const [references, setReferences] = useState({ fileIds: [] as string[], ready: true });
  const onReferences = useCallback((value: { fileIds: string[]; ready: boolean }) => setReferences(value), []);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (command.locked || created || !offering.policy) return;
    const form = new FormData(event.currentTarget); const text = String(form.get("brief") ?? "").normalize("NFC").trim();
    const referenceLinks = String(form.get("links") ?? "").split(/\r?\n/u).map((link) => link.trim()).filter(Boolean);
    let linksValid = referenceLinks.length <= 5 && new Set(referenceLinks).size === referenceLinks.length;
    for (const raw of referenceLinks) {
      try { const url = new URL(raw); linksValid &&= url.protocol === "https:" && !url.username && !url.password && new TextEncoder().encode(url.href).length <= 512; }
      catch { linksValid = false; }
    }
    if (!text || [...text].length > 3000 || !linksValid || !references.ready || !accepted) { setInvalid(true); firstField.current?.focus(); return; }
    setInvalid(false);
    command.execute("/api/v1/commissions", { packageId: offering.id, revisionId: offering.revisionId, policyRevisionId: offering.policy.revisionId,
      acceptTerms: true, brief: { text, referenceLinks }, ...(references.fileIds.length ? { referenceFileIds: references.fileIds } : {}) }, (value) => { const result = parseCommission(orderResultSchema, value); setCreated(true); router.push(`/commissions/${result.orderId}`); });
  }
  const available = offering.accepting && (offering.route !== "fixed_immediate" || offering.capacityAvailable);
  return <Card><CardHeader><CardTitle role="heading" aria-level={2}>Brief gửi nghệ sĩ</CardTitle><CardDescription>{offering.route === "fixed_immediate" ? "Sau khi gửi, bạn có 24 giờ để thanh toán theo hướng dẫn của đơn." : "Yêu cầu có hạn phản hồi 7 ngày và chưa giữ suất. Bạn thanh toán sau khi yêu cầu hoặc báo giá được chấp nhận."}</CardDescription></CardHeader><CardContent className="flex flex-col gap-4">
    {!available ? <Alert><AlertTitle>Gói hiện chưa nhận yêu cầu mới</AlertTitle><AlertDescription>Quay lại sau để kiểm tra tình trạng nhận việc.</AlertDescription></Alert> : null}
    <form method="post" action="/api/v1/commissions" onSubmit={submit}><FieldSet disabled={!available || command.locked || created}><FieldGroup>
      <Field data-invalid={invalid || undefined}><FieldLabel htmlFor={`${id}-brief`}>Mô tả yêu cầu của bạn</FieldLabel><Textarea ref={firstField} id={`${id}-brief`} name="brief" required rows={7} maxLength={6000} aria-invalid={invalid} aria-describedby={`${id}-brief-help`} /><FieldDescription id={`${id}-brief-help`}>Tối đa 3.000 ký tự. {offering.briefInstructions} Brief chỉ được người đặt và nghệ sĩ đọc trong đơn.</FieldDescription>{invalid ? <FieldError>Kiểm tra độ dài brief, các liên kết và xác nhận điều khoản.</FieldError> : null}</Field>
      <Field><FieldLabel htmlFor={`${id}-links`}>Liên kết tham khảo (không bắt buộc)</FieldLabel><Textarea id={`${id}-links`} name="links" rows={3} maxLength={2565} aria-describedby={`${id}-links-help`} /><FieldDescription id={`${id}-links-help`}>Tối đa 5 liên kết HTTPS, mỗi liên kết một dòng và tối đa 512 byte. Pawket không tải nội dung từ liên kết.</FieldDescription></Field>
      <ReferenceFilePicker packageId={offering.id} disabled={!available || command.locked || created} onChange={onReferences} />
      <Acceptance checked={accepted} onChange={setAccepted} disabled={command.locked} />
      <Button type="submit" className="self-start" disabled={!accepted || !references.ready}>{offering.route === "fixed_immediate" ? "Đặt commission và xem thanh toán" : "Gửi yêu cầu commission"}</Button>
    </FieldGroup></FieldSet></form><CommandFeedback command={command} />
  </CardContent></Card>;
}
