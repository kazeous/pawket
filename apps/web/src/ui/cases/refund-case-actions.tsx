"use client";
import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FieldGroup } from "@/components/ui/field";
import { Field } from "../field";
import { resolutionText } from "../resolutions/resolution-client";
import type { CaseAction } from "./case-client";
export function RefundCaseActions({ kind, disabled, onSubmit, now }: Readonly<{ kind: "refund_not_received" | "refund_overdue"; disabled: boolean; onSubmit(action: CaseAction): void; now?: Date }>) {
  const id = useId(); const [action, setAction] = useState(kind === "refund_not_received" ? "accept_evidence" : "extend_deadline"); const [error, setError] = useState<string | null>(null);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget); const reason = String(data.get("reason") ?? "").trim(); const until = new Date(String(data.get("until")));
    const at = now?.getTime() ?? Date.now();
    if (disabled || !resolutionText(reason, 2_000) || action === "extend_deadline" && (!Number.isFinite(until.getTime()) || until.getTime() <= at || until.getTime() > at + 30 * 86_400_000)) {
      setError("Nhập lý do 1–2.000 ký tự và thời hạn trong 30 ngày tới."); return;
    }
    setError(null);
    if (action === "extend_deadline") onSubmit({ action, reason, until: until.toISOString() });
    else onSubmit({ action: action as "accept_evidence" | "require_resend" | "waive", reason });
  }
  return <form className="stack" onSubmit={submit}><h2>Xử lý hoàn tiền</h2><FieldGroup>
    <Field htmlFor={`${id}-action`} label="Hành động" required><select id={`${id}-action`} name="refundAction" value={action} disabled={disabled} onChange={(event) => setAction(event.target.value)}>
      {kind === "refund_not_received" ? <><option value="accept_evidence">Chấp nhận bằng chứng đã nhận tiền</option><option value="require_resend">Yêu cầu chuyển lại</option></> : <option value="extend_deadline">Gia hạn chuyển hoàn tiền</option>}
      <option value="waive">Miễn nghĩa vụ hoàn tiền</option></select></Field>
    {action === "extend_deadline" ? <Field htmlFor={`${id}-until`} label="Hạn mới" required hint="Tối đa 30 ngày kể từ lúc xử lý; giờ trên thiết bị của bạn."><Input id={`${id}-until`} name="until" type="datetime-local" required disabled={disabled} /></Field> : null}
    <Field htmlFor={`${id}-reason`} label="Lý do" required error={error}><Textarea id={`${id}-reason`} name="reason" required disabled={disabled} /></Field></FieldGroup>
    <Button type="submit" disabled={disabled}>Xác nhận xử lý hoàn tiền</Button></form>;
}
