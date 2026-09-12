"use client";

import type { CreatorTipProjection } from "@pawket/payments";
import { useId, useRef, useState, type FormEvent } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Toggle } from "@/components/ui/toggle";
import { creatorTipErrorText, readCreatorTip } from "./creator-tip-client";
import { formatVnd, isRecord, tipRequest, TipRequestError } from "./tip-client";

type Evidence = { observedAmountVnd: number; observedTransferReference: string; observedBankTransactionId: string; attestedReceived: true };
export function CreatorTipConfirmation({ tip, onClose, onConfirmed }: Readonly<{ tip: CreatorTipProjection; onClose(): void; onConfirmed(): void }>) {
  const id = useId(); const busy = useRef(false); const firstInvalid = useRef<HTMLInputElement>(null);
  const [amount, setAmount] = useState(""); const [reference, setReference] = useState(""); const [bankId, setBankId] = useState(""); const [attested, setAttested] = useState(false);
  const [pending, setPending] = useState(false); const [locked, setLocked] = useState(false); const [error, setError] = useState(""); const [invalid, setInvalid] = useState(false);
  const [totpRequired, setTotpRequired] = useState(false); const [totp, setTotp] = useState(""); const [authRequired, setAuthRequired] = useState(false);
  const attempt = useRef<{ key: string; body: Evidence } | null>(null);
  async function confirm(event: FormEvent) {
    event.preventDefault(); if (busy.current) return;
    if (!attempt.current && (!/^[0-9]+$/u.test(amount) || Number(amount) !== tip.amountVnd || reference !== tip.reference || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/u.test(bankId.trim()) || !attested)) {
      setInvalid(true); setError("Đối chiếu đúng số tiền, nội dung chuyển khoản và mã giao dịch; chỉ xác nhận khi tiền đã vào tài khoản ngân hàng."); firstInvalid.current?.focus(); return;
    }
    if (totpRequired && !/^\d{6}$/u.test(totp)) { setError("Nhập mã xác thực gồm 6 chữ số."); return; }
    busy.current = true; setPending(true); setLocked(true); setError(""); setInvalid(false);
    try {
      if (totpRequired) {
        try { await tipRequest("/api/auth/two-factor/verify-totp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: totp, trustDevice: false }) }); }
        catch { setError("Chưa xác minh được mã TOTP. Kiểm tra mã mới trong ứng dụng xác thực rồi thử lại."); return; }
        finally { setTotp(""); }
        setTotpRequired(false);
      }
      if (!attempt.current) attempt.current = { key: crypto.randomUUID(), body: { observedAmountVnd: Number(amount), observedTransferReference: reference, observedBankTransactionId: bankId.trim(), attestedReceived: true } };
      const response = await tipRequest(`/api/v1/creator/tips/${tip.id}/confirm`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": attempt.current.key }, body: JSON.stringify(attempt.current.body) });
      const confirmed = readCreatorTip(isRecord(response) ? response.tip : null);
      if (confirmed.id !== tip.id || confirmed.reference !== tip.reference || confirmed.amountVnd !== tip.amountVnd || confirmed.state !== "confirmed") throw new TipRequestError("dependency_unavailable");
      attempt.current = null; onConfirmed();
    } catch (failure) {
      const code = failure instanceof TipRequestError ? failure.code : "dependency_unavailable";
      setError(creatorTipErrorText(code)); setAuthRequired(["recent_auth_required", "authentication_required"].includes(code));
      if (code === "totp_required") setTotpRequired(true);
      // Ambiguous responses and TOTP challenges keep the exact evidence/key for retries.
      if (["evidence_mismatch", "invalid_amount", "invalid_request", "bank_transaction_conflict"].includes(code)) { attempt.current = null; setLocked(false); }
    } finally { busy.current = false; setPending(false); }
  }
  return <AlertDialog open onOpenChange={(open) => { if (!open && !busy.current) onClose(); }}>
    <AlertDialogContent data-tip-surface className="min-w-0 overflow-x-hidden">
      <AlertDialogHeader><AlertDialogTitle>Xác nhận tiền tip đã nhận</AlertDialogTitle><AlertDialogDescription>Kiểm tra tiền thực nhận trong ứng dụng ngân hàng. Lời báo đã chuyển của khách không phải bằng chứng thanh toán.</AlertDialogDescription></AlertDialogHeader>
      <dl className="grid min-w-0 gap-2 text-sm"><div><dt>Số tiền cần đối chiếu</dt><dd className="font-semibold">{formatVnd(tip.amountVnd)}</dd></div><div><dt>Nội dung chuyển khoản cần đối chiếu</dt><dd className="break-all font-mono">{tip.reference}</dd></div></dl>
      <form id={`${id}-form`} method="post" action={`/api/v1/creator/tips/${tip.id}/confirm`} onSubmit={(event) => void confirm(event)}>
        <FieldGroup>
          <Field data-invalid={invalid || undefined}><FieldLabel htmlFor={`${id}-amount`}>Số tiền thực nhận (VND)</FieldLabel><Input ref={firstInvalid} id={`${id}-amount`} inputMode="numeric" autoComplete="off" maxLength={12} value={amount} disabled={locked} onChange={(e) => setAmount(e.target.value)} aria-invalid={invalid} aria-describedby={`${id}-evidence-help`} /></Field>
          <Field data-invalid={invalid || undefined}><FieldLabel htmlFor={`${id}-reference`}>Nội dung trên giao dịch ngân hàng</FieldLabel><Input id={`${id}-reference`} autoComplete="off" spellCheck={false} maxLength={40} value={reference} disabled={locked} onChange={(e) => setReference(e.target.value)} aria-invalid={invalid} aria-describedby={`${id}-evidence-help`} /></Field>
          <Field data-invalid={invalid || undefined}><FieldLabel htmlFor={`${id}-bank`}>Mã giao dịch ngân hàng</FieldLabel><Input id={`${id}-bank`} autoComplete="off" spellCheck={false} maxLength={100} value={bankId} disabled={locked} onChange={(e) => setBankId(e.target.value)} aria-invalid={invalid} aria-describedby={`${id}-evidence-help`} />
            <FieldDescription id={`${id}-evidence-help`}>Nhập nguyên số tiền VND, đúng nội dung PW và mã giao dịch từ ngân hàng của bạn. Mỗi mã giao dịch chỉ dùng để xác nhận một tip.</FieldDescription>{invalid ? <FieldError>Kiểm tra lại dữ liệu đối chiếu và lời xác nhận bên dưới.</FieldError> : null}</Field>
          <Field><Toggle variant="outline" pressed={attested} disabled={locked} onPressedChange={setAttested} aria-describedby={`${id}-attestation`} className="w-full">Tôi xác nhận đã nhận tiền</Toggle><FieldDescription id={`${id}-attestation`}>Tôi đã kiểm tra số tiền và nội dung khớp giao dịch thực nhận vào đúng tài khoản ngân hàng nhận tip của tôi.</FieldDescription></Field>
          {totpRequired ? <Field><FieldLabel htmlFor={`${id}-totp`}>Mã từ ứng dụng xác thực</FieldLabel><Input id={`${id}-totp`} autoComplete="one-time-code" inputMode="numeric" maxLength={6} value={totp} disabled={pending} onChange={(e) => setTotp(e.target.value)} /><FieldDescription>Mã TOTP gồm 6 chữ số; mã khôi phục không dùng để xác nhận tiền tip.</FieldDescription></Field> : null}
          {error ? <Alert variant="destructive"><AlertTitle>Chưa xác nhận được tip</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
          {authRequired ? <Button variant="outline" nativeButton={false} render={<a href="/sign-in" referrerPolicy="no-referrer" />}>Đăng nhập lại</Button> : null}
        </FieldGroup>
      </form>
      <AlertDialogFooter><AlertDialogCancel disabled={pending}>Đóng đối chiếu</AlertDialogCancel><AlertDialogAction type="submit" form={`${id}-form`} disabled={pending || authRequired}>{pending ? <Spinner data-icon="inline-start" /> : null}{pending ? "Đang kiểm tra…" : totpRequired ? "Xác thực và xác nhận" : locked ? "Thử lại lần xác nhận này" : "Xác nhận đã nhận tiền"}</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
