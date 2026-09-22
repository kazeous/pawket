"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatTipTime, formatVnd, isRecord, requireTipDraftActor, tipRequest, TipRequestError } from "@/ui/tips/tip-client";
import { readTipPolicy, tipPolicyDraft, validateTipPolicyDraft, type TipPolicyCommand, type TipPolicyDraft, type TipPolicyDraftErrors, type TipPolicyView } from "@/ui/tips/tip-policy-client";
import { ownerTipPolicyError, ownerTipPolicyRequest, readOwnerTipPolicyData, type OwnerTipPolicyData } from "./owner-tip-policy-client";

const endpoint = "/api/v1/admin/tip-policy";
const query = (before?: number) => `${endpoint}${before ? `?beforeRevision=${before}` : ""}`;
const describePolicy = (policy: Pick<TipPolicyView, "minimumVnd" | "maximumVnd" | "allowedPresetsVnd">) =>
  `${formatVnd(policy.minimumVnd)} – ${formatVnd(policy.maximumVnd)}; gợi ý: ${policy.allowedPresetsVnd.map(formatVnd).join(", ")}`;

export function OwnerTipPolicyWorkbench({ initialActorUserId }: Readonly<{ initialActorUserId: string }>) {
  const id = useId(); const form = useRef<HTMLFormElement>(null); const totpInput = useRef<HTMLInputElement>(null); const busy = useRef(false);
  const attempt = useRef<{ key: string; body: TipPolicyCommand } | null>(null);
  const [data, setData] = useState<OwnerTipPolicyData | null>(null);
  const [draft, setDraft] = useState<TipPolicyDraft | null>(null);
  const [errors, setErrors] = useState<TipPolicyDraftErrors>({});
  const [pending, setPending] = useState(false); const [locked, setLocked] = useState(false);
  const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false); const [reviewRequired, setReviewRequired] = useState(false);
  const [totpRequired, setTotpRequired] = useState(false); const [totp, setTotp] = useState(""); const [totpInvalid, setTotpInvalid] = useState(false);
  const [historyCursors, setHistoryCursors] = useState<(number | undefined)[]>([undefined]);
  useEffect(() => {
    let active = true;
    void requireTipDraftActor(initialActorUserId).then(() => ownerTipPolicyRequest(query())).then(readOwnerTipPolicyData).then((value) => {
      if (active) { setData(value); setDraft(value.policy ? tipPolicyDraft(value.policy) : null); }
    }).catch((failure: unknown) => { if (active) setError(ownerTipPolicyError(failure instanceof TipRequestError ? failure.code : "dependency_unavailable")); });
    return () => { active = false; };
  }, [initialActorUserId]);
  useEffect(() => { if (totpRequired) totpInput.current?.focus(); }, [totpRequired]);

  async function reload() {
    if (busy.current) return; busy.current = true; setPending(true); setError("");
    try {
      await requireTipDraftActor(initialActorUserId);
      const value = readOwnerTipPolicyData(await ownerTipPolicyRequest(query()));
      setData(value); setDraft((previous) => previous ?? (value.policy ? tipPolicyDraft(value.policy) : null));
      setHistoryCursors([undefined]); setConflict(false); setReviewRequired(Boolean(draft && value.policy));
      attempt.current = null; setLocked(false); setTotpRequired(false); setTotp("");
      setNotice("Đã tải chính sách mới nhất. Nội dung bạn đang nhập được giữ lại để đối chiếu.");
    } catch (failure) { setError(ownerTipPolicyError(failure instanceof TipRequestError ? failure.code : "dependency_unavailable")); }
    finally { busy.current = false; setPending(false); }
  }
  async function history(cursors: (number | undefined)[]) {
    if (busy.current) return; busy.current = true; setPending(true); setError("");
    try {
      await requireTipDraftActor(initialActorUserId);
      const value = readOwnerTipPolicyData(await ownerTipPolicyRequest(query(cursors.at(-1))));
      setData((previous) => previous ? { ...previous, history: value.history } : value); setHistoryCursors(cursors);
    } catch (failure) { setError(ownerTipPolicyError(failure instanceof TipRequestError ? failure.code : "dependency_unavailable")); }
    finally { busy.current = false; setPending(false); }
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!draft || !data?.policy || busy.current || conflict || reviewRequired) return;
    const validation = validateTipPolicyDraft(draft, data.policy.revisionNumber); setErrors(validation.errors);
    if (!validation.command) { requestAnimationFrame(() => form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()); return; }
    if (totpRequired && !/^\d{6}$/u.test(totp)) { setTotpInvalid(true); totpInput.current?.focus(); return; }
    busy.current = true; setPending(true); setLocked(true); setError(""); setNotice("");
    if (!attempt.current) attempt.current = { key: crypto.randomUUID(), body: validation.command };
    try {
      await requireTipDraftActor(initialActorUserId);
      if (totpRequired) {
        try { await tipRequest("/api/auth/two-factor/verify-totp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: totp, trustDevice: false }) }); }
        catch { setTotpInvalid(true); setError("Chưa xác minh được mã TOTP. Kiểm tra mã mới trong ứng dụng xác thực rồi thử lại."); return; }
        finally { setTotp(""); }
        setTotpRequired(false); setTotpInvalid(false);
      }
      const result = await ownerTipPolicyRequest(endpoint, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": attempt.current.key }, body: JSON.stringify(attempt.current.body) });
      const policy = readTipPolicy(isRecord(result) ? result.policy : null); const command = attempt.current.body;
      if (policy.revisionNumber !== command.expectedRevision + 1 || policy.minimumVnd !== command.minimumVnd || policy.maximumVnd !== command.maximumVnd || JSON.stringify(policy.allowedPresetsVnd) !== JSON.stringify(command.allowedPresetsVnd)) throw new TipRequestError("dependency_unavailable");
      attempt.current = null; setLocked(false); setData({ ...data, policy }); setDraft(tipPolicyDraft(policy)); setHistoryCursors([undefined]);
      setNotice(`Đã lưu chính sách phiên bản ${policy.revisionNumber}. Áp dụng cho tip mới; phiếu đã tạo giữ nguyên.`);
      try { const refreshed = readOwnerTipPolicyData(await ownerTipPolicyRequest(query())); setData(refreshed); setDraft(refreshed.policy ? tipPolicyDraft(refreshed.policy) : null); }
      catch { setNotice(`Đã lưu chính sách phiên bản ${policy.revisionNumber}. Chưa tải được lịch sử mới; tải lại để kiểm tra.`); }
    } catch (failure) {
      const code = failure instanceof TipRequestError ? failure.code : "dependency_unavailable"; setError(ownerTipPolicyError(code));
      if (code === "owner_totp_required") setTotpRequired(true);
      if (["version_conflict", "idempotency_conflict"].includes(code)) { setConflict(true); attempt.current = null; setLocked(false); setTotpRequired(false); }
      if (code === "invalid_request") { attempt.current = null; setLocked(false); setTotpRequired(false); }
    } finally { busy.current = false; setPending(false); }
  }
  const preview = draft && data?.policy ? validateTipPolicyDraft(draft, data.policy.revisionNumber).command : null;
  const disabled = pending || locked || conflict || reviewRequired;
  return <>
    <Alert role="note"><AlertTitle>{data ? data.paymentsEnabled && data.publishingEnabled ? "Nhận tip đang khả dụng" : "Nhận tip đang tạm đóng" : "Đang kiểm tra trạng thái nhận tip"}</AlertTitle><AlertDescription>Lưu chính sách không bật nhận tip hay xuất bản trang creator.</AlertDescription></Alert>
    {!data && !error ? <p role="status"><Spinner data-icon="inline-start" /> Đang tải chính sách…</p> : null}
    {data && !data.policy ? <Alert variant="destructive"><AlertTitle>Chưa có chính sách hợp lệ</AlertTitle><AlertDescription>Cần kiểm tra cấu hình dữ liệu trước khi chỉnh sửa. Các trang khác vẫn có thể hoạt động.</AlertDescription></Alert> : null}
    {data?.policy && draft ? <form ref={form} onSubmit={(event) => void save(event)} noValidate aria-labelledby={`${id}-title`}>
      <Card><CardHeader><CardTitle id={`${id}-title`} role="heading" aria-level={2}>Giới hạn và mức gợi ý</CardTitle><CardDescription>Phiên bản {data.policy.revisionNumber} · Hiệu lực {formatTipTime(data.policy.effectiveAt)}</CardDescription></CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-5">
          <p>Hiện tại: {describePolicy(data.policy)}</p>
          <FieldGroup>
            {(["minimum", "maximum"] as const).map((key) => <Field key={key} data-invalid={!!errors[key]} data-disabled={disabled || undefined}><FieldLabel htmlFor={`${id}-${key}`}>{key === "minimum" ? "Số tiền tối thiểu (VND)" : "Số tiền tối đa (VND)"}</FieldLabel><Input id={`${id}-${key}`} inputMode="numeric" autoComplete="off" maxLength={7} disabled={disabled} value={draft[key]} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} aria-invalid={!!errors[key]} aria-describedby={`${id}-${key}-error`} /><FieldError id={`${id}-${key}-error`}>{errors[key]}</FieldError></Field>)}
            <Field><FieldLabel>Mức gợi ý theo thứ tự hiển thị</FieldLabel><FieldDescription>Cần 3–10 mức khác nhau. Ba mức đầu là mặc định cho creator có lựa chọn không còn phù hợp.</FieldDescription><FieldError>{errors.presets}</FieldError></Field>
            {draft.presets.map((value, index) => <Field key={index} data-invalid={!!errors[`preset-${index}`]} data-disabled={disabled || undefined}>
              <FieldLabel htmlFor={`${id}-preset-${index}`}>Mức gợi ý {index + 1}{index < 3 ? " · Mặc định" : ""}</FieldLabel>
              <div className="flex min-w-0 flex-wrap gap-2"><Input className="min-w-0 flex-1" id={`${id}-preset-${index}`} inputMode="numeric" autoComplete="off" maxLength={7} value={value} disabled={disabled} onChange={(event) => setDraft({ ...draft, presets: draft.presets.map((v, i) => i === index ? event.target.value : v) })} aria-invalid={!!errors[`preset-${index}`]} aria-describedby={`${id}-preset-${index}-error`} /><Button type="button" variant="outline" disabled={disabled || draft.presets.length <= 3} aria-label={`Xóa mức gợi ý ${index + 1}`} onClick={() => { setDraft({ ...draft, presets: draft.presets.filter((_, i) => i !== index) }); requestAnimationFrame(() => document.getElementById(`${id}-preset-${Math.max(0, index - 1)}`)?.focus()); }}>Xóa</Button></div><FieldError id={`${id}-preset-${index}-error`}>{errors[`preset-${index}`]}</FieldError>
            </Field>)}
            <Field><Button type="button" variant="outline" disabled={disabled || draft.presets.length >= 10} onClick={() => { const index = draft.presets.length; setDraft({ ...draft, presets: [...draft.presets, ""] }); requestAnimationFrame(() => document.getElementById(`${id}-preset-${index}`)?.focus()); }}>Thêm mức gợi ý</Button></Field>
            <Field data-invalid={!!errors.reason} data-disabled={disabled || undefined}><FieldLabel htmlFor={`${id}-reason`}>Lý do thay đổi</FieldLabel><Input id={`${id}-reason`} value={draft.reason} maxLength={1000} disabled={disabled} onChange={(event) => setDraft({ ...draft, reason: event.target.value })} aria-invalid={!!errors.reason} aria-describedby={`${id}-reason-error`} /><FieldDescription>3–500 ký tự. Lý do được lưu trong lịch sử dành riêng cho owner.</FieldDescription><FieldError id={`${id}-reason-error`}>{errors.reason}</FieldError></Field>
          </FieldGroup>
          <Alert role="note"><AlertTitle>Đối chiếu trước khi lưu</AlertTitle><AlertDescription><p>Trước: {describePolicy(data.policy)}</p><p>Sau: {preview ? describePolicy(preview) : "Hoàn tất các trường hợp lệ để xem thay đổi."}</p><p>Creator có mức gợi ý không còn hợp lệ sẽ dùng ba mức mặc định mới và có thể chọn lại. Số tiền, thông tin nhận tiền và thời hạn của phiếu tip đã tạo giữ nguyên.</p></AlertDescription></Alert>
          {totpRequired ? <Field data-invalid={totpInvalid} data-disabled={pending || undefined}><FieldLabel htmlFor={`${id}-totp`}>Mã từ ứng dụng xác thực</FieldLabel><Input ref={totpInput} id={`${id}-totp`} inputMode="numeric" autoComplete="one-time-code" maxLength={6} disabled={pending} value={totp} onChange={(event) => { setTotp(event.target.value); setTotpInvalid(false); }} aria-invalid={totpInvalid} aria-describedby={`${id}-totp-help`} /><FieldDescription id={`${id}-totp-help`}>Nhập mã TOTP gồm 6 chữ số để xác nhận đúng thay đổi đang hiển thị.</FieldDescription><FieldError>{totpInvalid ? "Kiểm tra mã TOTP gồm 6 chữ số." : null}</FieldError></Field> : null}
          <noscript>Bật JavaScript để chỉnh sửa chính sách tip.</noscript>
        </CardContent><CardFooter className="flex flex-wrap gap-3"><Button type="submit" disabled={pending || conflict || reviewRequired}>{pending ? <Spinner data-icon="inline-start" /> : null}{pending ? "Đang kiểm tra…" : totpRequired ? "Xác thực và lưu chính sách" : locked ? "Thử lại lần lưu này" : "Lưu chính sách"}</Button>{reviewRequired ? <Button type="button" variant="outline" onClick={() => { setReviewRequired(false); setNotice("Đã đối chiếu. Bạn có thể sửa nội dung hoặc lưu thay đổi."); }}>Đã đối chiếu chính sách mới</Button> : null}</CardFooter>
      </Card>
    </form> : null}
    {error ? <Alert variant="destructive"><AlertTitle>Chưa hoàn tất yêu cầu</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
    <p role="status" aria-live="polite">{notice}</p>
    {error ? <div className="flex flex-wrap gap-3"><Button type="button" variant="outline" disabled={pending || locked} onClick={() => void reload()}>Tải chính sách mới nhất</Button><a className={buttonVariants({ variant: "ghost" })} href="/sign-in/reauth" target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Đăng nhập lại trong tab mới</a><p>Đăng nhập đúng tài khoản trong tab mới rồi quay lại tab này. Nội dung đang nhập được giữ nguyên.</p></div> : null}
    {data ? <Card><CardHeader><CardTitle role="heading" aria-level={2}>Lịch sử chính sách</CardTitle><CardDescription>Mỗi lần lưu tạo một phiên bản mới. Các phiên bản trước không bị sửa.</CardDescription></CardHeader><CardContent className="min-w-0">
      <Table tabIndex={0} aria-label="Lịch sử thay đổi chính sách tip"><TableCaption>Lịch sử dành riêng cho owner; tối đa 25 phiên bản mỗi trang.</TableCaption><TableHeader><TableRow><TableHead scope="col">Phiên bản</TableHead><TableHead scope="col">Thay đổi</TableHead><TableHead scope="col">Người thực hiện và lý do</TableHead></TableRow></TableHeader><TableBody>{data.history.revisions.map((entry) => <TableRow key={entry.revisionId}><TableCell><p>{entry.revisionNumber}</p><p>{formatTipTime(entry.effectiveAt)}</p></TableCell><TableCell className="min-w-48 whitespace-normal"><p>Trước: {entry.previousPolicy ? describePolicy(entry.previousPolicy) : "Chưa có chính sách"}</p><p>Sau: {describePolicy(entry)}</p></TableCell><TableCell className="min-w-48 whitespace-normal"><p className="break-all">{entry.origin === "system_bootstrap" ? "Khởi tạo hệ thống" : entry.actorUserId}</p><p className="break-words">{entry.reason}</p></TableCell></TableRow>)}</TableBody></Table>
    </CardContent><CardFooter className="flex flex-wrap gap-3"><Button type="button" variant="outline" disabled={pending || locked || historyCursors.length <= 1} onClick={() => void history(historyCursors.slice(0, -1))}>Lịch sử mới hơn</Button><Button type="button" variant="outline" disabled={pending || locked || data.history.nextBeforeRevision === null} onClick={() => { if (data.history.nextBeforeRevision !== null) void history([...historyCursors, data.history.nextBeforeRevision]); }}>Lịch sử cũ hơn</Button></CardFooter></Card> : null}
  </>;
}
