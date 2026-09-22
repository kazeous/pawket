"use client";

import type { TipInstructionProjection } from "@pawket/payments";
import type { PublicTipOffering } from "@pawket/tips";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { PaymentInstruction } from "./payment-instruction";
import { formatVnd, isRecord, readCreatedInstruction, readTipOffering, tipErrorText, tipRequest, TipRequestError } from "./tip-client";

type Errors = Partial<Record<"amount" | "name" | "message", string>>;
type Attempt = { key: string; body: { amountVnd: number; name: string; message: string } };

export function TipForm({ offering: initialOffering }: Readonly<{ offering: PublicTipOffering }>) {
  const id = useId(); const formRef = useRef<HTMLFormElement>(null); const busy = useRef(false);
  const attempt = useRef<Attempt | null>(null);
  const [offering, setOffering] = useState(initialOffering);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [amount, setAmount] = useState(String(offering.presetsVnd[0]));
  const [name, setName] = useState(""); const [message, setMessage] = useState("");
  const [errors, setErrors] = useState<Errors>({}); const [error, setError] = useState("");
  const [pending, setPending] = useState(false); const [locked, setLocked] = useState(false);
  const [instruction, setInstruction] = useState<TipInstructionProjection | null>(null);
  const resultRef = useRef<HTMLElement>(null);
  useEffect(() => { if (instruction) resultRef.current?.focus(); }, [instruction]);

  async function refreshOffering() {
    try {
      const latest = readTipOffering(await tipRequest(`/api/v1/public/creators/${offering.canonicalHandle}/tips`), offering.canonicalHandle);
      setOffering(latest); setRefreshRequired(false); setError(tipErrorText("policy_changed"));
      if (Number(amount) < latest.minimumVnd || Number(amount) > latest.maximumVnd) setErrors((previous) => ({ ...previous, amount: `Chính sách mới yêu cầu số tiền từ ${formatVnd(latest.minimumVnd)} đến ${formatVnd(latest.maximumVnd)}. Số tiền bạn nhập chưa được thay đổi.` }));
      requestAnimationFrame(() => document.getElementById(`${id}-amount`)?.focus());
    } catch {
      setRefreshRequired(true); setError("Chính sách số tiền đã thay đổi nhưng chưa tải được giới hạn mới. Tải lại mức gợi ý để tiếp tục; nội dung bạn nhập vẫn được giữ nguyên.");
    }
  }

  async function retryRefresh() {
    if (busy.current) return; busy.current = true; setPending(true);
    try { await refreshOffering(); } finally { busy.current = false; setPending(false); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy.current || refreshRequired) return;
    const next: Errors = {};
    if (!/^[0-9]{1,7}$/u.test(amount) || !Number.isSafeInteger(Number(amount)) || Number(amount) < offering.minimumVnd || Number(amount) > offering.maximumVnd) next.amount = `Nhập số nguyên từ ${formatVnd(offering.minimumVnd)} đến ${formatVnd(offering.maximumVnd)}, không dùng dấu chấm hoặc dấu phẩy.`;
    if (Array.from(name.normalize("NFC").trim()).length > 80) next.name = "Tên tối đa 80 ký tự.";
    if (Array.from(message.normalize("NFC").trim()).length > 280) next.message = "Lời nhắn tối đa 280 ký tự.";
    setErrors(next); setError("");
    if (Object.keys(next).length) { requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()); return; }
    busy.current = true; setPending(true); setLocked(true);
    try {
      if (!attempt.current) attempt.current = { key: crypto.randomUUID(), body: { amountVnd: Number(amount), name, message } };
      const context = await tipRequest("/api/v1/tips/guest-context", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (!isRecord(context) || context.ready !== true) throw new TipRequestError("dependency_unavailable");
      const result = await tipRequest(`/api/v1/public/creators/${offering.canonicalHandle}/tips`, {
        method: "POST", headers: { "content-type": "application/json", "idempotency-key": attempt.current.key }, body: JSON.stringify(attempt.current.body),
      });
      setInstruction(readCreatedInstruction(result, offering.canonicalHandle, attempt.current.body.amountVnd));
      setName(""); setMessage(""); attempt.current = null;
    } catch (failure) {
      const code = failure instanceof TipRequestError ? failure.code : "dependency_unavailable";
      setError(tipErrorText(code));
      if (code === "policy_changed") { attempt.current = null; setLocked(false); setRefreshRequired(true); await refreshOffering(); }
      // A lost/ambiguous response must retry the same immutable command.
      if (["invalid_amount", "invalid_guest_content", "invalid_request"].includes(code)) { attempt.current = null; setLocked(false); }
    } finally { busy.current = false; setPending(false); }
  }

  if (instruction) return <section data-tip-surface ref={resultRef} id={`${id}-result`} tabIndex={-1} aria-label="Hướng dẫn chuyển khoản">
    <PaymentInstruction instruction={instruction} footer={<>
      <p>Quyền xem phiếu tip được lưu trong trình duyệt này. Giữ lại phiếu để xem trạng thái.</p>
      <Button nativeButton={false} render={<a href={`/tips/${instruction.reference}`} referrerPolicy="no-referrer" />}>Mở phiếu tip</Button>
    </>} />
  </section>;
  return <form data-tip-surface ref={formRef} method="post" action={`/api/v1/public/creators/${offering.canonicalHandle}/tips`} onSubmit={(event) => void submit(event)} noValidate aria-labelledby={`${id}-title`}>
    <Card>
      <CardHeader><CardTitle id={`${id}-title`} role="heading" aria-level={2}>Gửi tip cho {offering.displayName}</CardTitle>
        <CardDescription>Một lời cảm ơn dành cho sáng tạo bạn yêu thích.</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-5">
        <noscript>Hãy bật JavaScript và cookie để tạo hướng dẫn chuyển khoản và giữ quyền xem phiếu tip.</noscript>
        <Alert role="note"><AlertTitle>Chuyển khoản trực tiếp</AlertTitle><AlertDescription>Tiền được chuyển vào tài khoản của nghệ sĩ. Pawket không giữ tiền và không tự xác nhận giao dịch.</AlertDescription></Alert>
        <FieldGroup>
          <Field data-disabled={locked || undefined}><FieldLabel id={`${id}-presets`}>Chọn nhanh số tiền</FieldLabel>
            <ToggleGroup multiple={false} variant="outline" className="max-w-full flex-wrap" disabled={locked}
              aria-labelledby={`${id}-presets`} value={offering.presetsVnd.map(String).includes(amount) ? [amount] : []}
              onValueChange={(values) => { if (values[0]) { setAmount(values[0]); setErrors((v) => ({ ...v, amount: undefined })); } }}>
              {offering.presetsVnd.map((value) => <ToggleGroupItem key={value} value={String(value)} aria-label={`Tip ${formatVnd(value)}`}>{formatVnd(value)}</ToggleGroupItem>)}
            </ToggleGroup>
          </Field>
          <Field data-invalid={!!errors.amount} data-disabled={locked || undefined}>
            <FieldLabel htmlFor={`${id}-amount`}>Số tiền (VND)</FieldLabel>
            <Input id={`${id}-amount`} name="amount" inputMode="numeric" autoComplete="off" maxLength={24} value={amount} disabled={locked}
              onChange={(event) => setAmount(event.target.value)} aria-invalid={!!errors.amount} aria-describedby={`${id}-amount-hint${errors.amount ? ` ${id}-amount-error` : ""}`} />
            <FieldDescription id={`${id}-amount-hint`}>Từ {formatVnd(offering.minimumVnd)} đến {formatVnd(offering.maximumVnd)}. Chỉ nhập chữ số, ví dụ 50000.</FieldDescription>
            <FieldError id={`${id}-amount-error`}>{errors.amount}</FieldError>
          </Field>
          <Field data-invalid={!!errors.name} data-disabled={locked || undefined}>
            <FieldLabel htmlFor={`${id}-name`}>Tên hiển thị (không bắt buộc)</FieldLabel>
            <Input id={`${id}-name`} name="name" value={name} autoComplete="off" maxLength={320} disabled={locked} onChange={(event) => setName(event.target.value)}
              aria-invalid={!!errors.name} aria-describedby={`${id}-name-hint${errors.name ? ` ${id}-name-error` : ""}`} />
            <FieldDescription id={`${id}-name-hint`}>Tối đa 80 ký tự.</FieldDescription><FieldError id={`${id}-name-error`}>{errors.name}</FieldError>
          </Field>
          <Field data-invalid={!!errors.message} data-disabled={locked || undefined}>
            <FieldLabel htmlFor={`${id}-message`}>Lời nhắn (không bắt buộc)</FieldLabel>
            <Textarea id={`${id}-message`} name="message" value={message} maxLength={1120} rows={3} disabled={locked} onChange={(event) => setMessage(event.target.value)}
              aria-invalid={!!errors.message} aria-describedby={`${id}-message-hint${errors.message ? ` ${id}-message-error` : ""}`} />
            <FieldDescription id={`${id}-message-hint`}>Tối đa 280 ký tự. Nghệ sĩ chỉ đọc được tên và lời nhắn sau khi xác nhận đã nhận tiền.</FieldDescription><FieldError id={`${id}-message-error`}>{errors.message}</FieldError>
          </Field>
        </FieldGroup>
        {error ? <Alert variant="destructive"><AlertTitle>Chưa tạo được hướng dẫn</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-3"><Button type="submit" disabled={pending || refreshRequired}>{pending ? <Spinner data-icon="inline-start" /> : null}{pending ? "Đang tạo hướng dẫn…" : locked ? "Thử lại yêu cầu này" : "Tạo hướng dẫn chuyển khoản"}</Button>{refreshRequired ? <Button type="button" variant="outline" disabled={pending} onClick={() => void retryRefresh()}>Tải lại mức gợi ý</Button> : null}</CardFooter>
    </Card>
  </form>;
}
