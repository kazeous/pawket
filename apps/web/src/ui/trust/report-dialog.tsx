"use client";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { StatusBanner } from "@/ui/status-banner";
import { LoadingState } from "@/ui/async-state";
import { solveReportChallenge } from "@/app/creators/[handle]/report-proof";
import { tipRequest } from "../tips/tip-client";
import { TrustCommandFeedback, useTrustCommand } from "./trust-command";
import { parseCommission } from "../commissions/commission-client";
import { reportChallengeSchema, reportInputSchema, reportReasonLabels, reportResultSchema, type ReportTarget, type TrustMode } from "./trust-client";

type ReportInput = ReturnType<typeof reportInputSchema.parse>;
type Props = Readonly<{ target: ReportTarget; mode: TrustMode; ownContent?: boolean; guest?: boolean; actorUserId?: string }>;
const success = "Đã gửi báo cáo. Pawket sẽ xem xét; người bị báo cáo không biết bạn là ai.";
export function ReportDialog({ target, mode, ownContent = false, guest = false, actorUserId }: Props) {
  if (mode !== "enabled" || ownContent || guest && target.kind !== "commission_package") return null;
  return guest ? <GuestReport target={target} /> : <AuthenticatedReport target={target} actorUserId={actorUserId} />;
}
function ReportSurface({ target, locked, accepted, onSubmit, feedback, onCancel }: Readonly<{
  target: ReportTarget; locked: boolean; accepted: boolean; onSubmit(input: ReportInput): void; feedback?: ReactNode; onCancel?(): void;
}>) {
  const [open, setOpen] = useState(false); const [invalid, setInvalid] = useState(false); const id = useId();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (locked) return;
    const form = new FormData(event.currentTarget); const input = reportInputSchema.safeParse({ target, reason: form.get("reason"), detail: form.get("detail") });
    setInvalid(!input.success); if (input.success) onSubmit(input.data);
  }
  return <AlertDialog open={open} onOpenChange={(next) => { if (!locked) setOpen(next); }}>
    <AlertDialogTrigger render={<Button variant="ghost" size="sm" />}>Báo cáo</AlertDialogTrigger>
    <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Báo cáo nội dung</AlertDialogTitle><AlertDialogDescription>Pawket sẽ xem xét nội dung bạn báo cáo.</AlertDialogDescription></AlertDialogHeader>
      {accepted ? <StatusBanner tone="success">{success}</StatusBanner> : <form aria-label="Báo cáo nội dung" onSubmit={submit}><FieldGroup>{feedback}
        <Field data-disabled={locked || undefined}><FieldLabel htmlFor={`${id}-reason`}>Lý do báo cáo</FieldLabel><NativeSelect id={`${id}-reason`} name="reason" disabled={locked} required defaultValue="privacy">
          {Object.entries(reportReasonLabels).map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}
        </NativeSelect></Field>
        <Field data-disabled={locked || undefined} data-invalid={invalid || undefined}><FieldLabel htmlFor={`${id}-detail`}>Chi tiết</FieldLabel>
          <Textarea id={`${id}-detail`} name="detail" maxLength={2000} disabled={locked} aria-invalid={invalid || undefined} aria-describedby={`${id}-help${invalid ? ` ${id}-error` : ""}`} />
          <FieldDescription id={`${id}-help`}>Không nhập thông tin cá nhân của bạn; tối đa 1.000 ký tự.</FieldDescription>
          {invalid ? <FieldError id={`${id}-error`}>Kiểm tra lý do và chi tiết, tối đa 1.000 ký tự hợp lệ.</FieldError> : null}
        </Field><Button type="submit" disabled={locked}>Gửi báo cáo</Button>
      </FieldGroup></form>}
      <Button variant="outline" disabled={locked && !onCancel} onClick={() => { onCancel?.(); if (!locked) setOpen(false); }}>{locked && onCancel ? "Hủy tạo bằng chứng" : "Đóng"}</Button>
    </AlertDialogContent>
  </AlertDialog>;
}
function AuthenticatedReport({ target, actorUserId }: Readonly<{ target: ReportTarget; actorUserId?: string | undefined }>) {
  const command = useTrustCommand(actorUserId); const [accepted, setAccepted] = useState(false);
  return <ReportSurface target={target} locked={command.locked} accepted={accepted} feedback={<TrustCommandFeedback command={command} />}
    onSubmit={(input) => command.execute("/api/v1/reports", input, (value) => { parseCommission(reportResultSchema, value); setAccepted(true); })} />;
}
function GuestReport({ target }: Readonly<{ target: ReportTarget }>) {
  const controller = useRef<AbortController | null>(null); const [busy, setBusy] = useState(false); const [progress, setProgress] = useState(0);
  const [accepted, setAccepted] = useState(false); const [failed, setFailed] = useState(false); const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, []);
  async function submit(input: ReportInput) {
    if (controller.current) return;
    const abort = new AbortController(); controller.current = abort; setBusy(true); setFailed(false); setProgress(0);
    try {
      const challenge = parseCommission(reportChallengeSchema, await tipRequest("/api/v1/reports/challenge", { method: "POST", signal: abort.signal }));
      if (abort.signal.aborted) return;
      const solution = await solveReportChallenge(challenge, abort.signal, (value) => { if (alive.current && !abort.signal.aborted) setProgress(value); });
      if (abort.signal.aborted) return;
      const result = await tipRequest("/api/v1/reports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...input, challenge: { token: challenge.token, solution } }), signal: abort.signal });
      parseCommission(reportResultSchema, result); if (alive.current && !abort.signal.aborted) setAccepted(true);
    } catch { if (alive.current && !abort.signal.aborted) setFailed(true); }
    finally { controller.current = null; if (alive.current) setBusy(false); }
  }
  return <ReportSurface target={target} locked={busy} accepted={accepted} onSubmit={(input) => void submit(input)} onCancel={() => controller.current?.abort()}
    feedback={<>{busy ? <><LoadingState label="Đang chuẩn bị bằng chứng…" /><p role="status">Đã thử {progress.toLocaleString("vi-VN")} mã. Bạn có thể hủy bất cứ lúc nào.</p></> : null}{failed ? <StatusBanner tone="error">Chưa thể gửi báo cáo. Hãy thử lại sau.</StatusBanner> : null}</>} />;
}
