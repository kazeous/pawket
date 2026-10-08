"use client";

import { useId, useState, type FormEvent } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FieldGroup, FieldSet, Field as CheckboxField, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/ui/field";
import { ActionBar } from "@/ui/action-bar";
import { StatusBanner } from "@/ui/status-banner";
import { SummaryList } from "@/ui/summary-list";
import { formatTipTime, formatVnd } from "@/ui/tips/tip-client";
import type { OrderView } from "../commissions/commission-client";
import { reasonLabels, resolutionText, type ResolutionView } from "./resolution-client";

export const disputeInputSchema = z.object({ expectedVersion: z.number().int().positive(), reason: z.enum(Object.keys(reasonLabels) as [keyof typeof reasonLabels, ...Array<keyof typeof reasonLabels>]),
  statement: z.string().refine((text) => resolutionText(text, 4000)), acknowledgeStaffReview: z.literal(true),
  requestedOutcome: z.object({ kind: z.enum(["close", "complete"]), refundAmountVnd: z.number().int().min(0).max(50_000_000) }) });
export function DisputeForm({ order, disabled, onSubmit }: Readonly<{ order: OrderView["order"]; disabled: boolean; onSubmit(payload: z.infer<typeof disputeInputSchema>): void }>) {
  const id = useId(); const [acknowledged, setAcknowledged] = useState(false); const [invalid, setInvalid] = useState(false); const [outcome, setOutcome] = useState("close");
  const paid = order.payment?.amountVnd ?? order.terms?.amountVnd ?? 0;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (disabled || !acknowledged) return; const form = new FormData(event.currentTarget);
    const result = disputeInputSchema.safeParse({ expectedVersion: order.version, reason: form.get("reason"), statement: form.get("statement"), acknowledgeStaffReview: acknowledged,
      requestedOutcome: { kind: form.get("outcome"), refundAmountVnd: Number(form.get("amount")) } });
    if (!result.success || result.data.requestedOutcome.refundAmountVnd > paid - (outcome === "complete" ? 1 : 0) || outcome === "complete" && order.state !== "delivered") { setInvalid(true); return; }
    setInvalid(false); onSubmit(result.data);
  }
  return <form onSubmit={submit}><FieldSet disabled={disabled}><FieldGroup>
    <Field htmlFor={`${id}-reason`} label="Lý do"><NativeSelect id={`${id}-reason`} name="reason">{Object.entries(reasonLabels).map(([value, label]) => <NativeSelectOption value={value} key={value}>{label}</NativeSelectOption>)}</NativeSelect></Field>
    <Field htmlFor={`${id}-statement`} label="Trình bày" hint="1–4.000 ký tự." required><Textarea id={`${id}-statement`} name="statement" required /></Field>
    <Field htmlFor={`${id}-outcome`} label="Kết quả mong muốn"><NativeSelect id={`${id}-outcome`} name="outcome" value={outcome} onChange={(event) => setOutcome(event.target.value)}><NativeSelectOption value="close">Hủy đơn</NativeSelectOption>{order.state === "delivered" ? <NativeSelectOption value="complete">Hoàn tất đơn</NativeSelectOption> : null}</NativeSelect></Field>
    <Field htmlFor={`${id}-amount`} label="Số tiền muốn hoàn (VND)" required><Input id={`${id}-amount`} name="amount" type="number" min={0} max={paid - (outcome === "complete" ? 1 : 0)} step={1} defaultValue={0} required /></Field>
    <CheckboxField orientation="horizontal"><Checkbox id={`${id}-review`} checked={acknowledged} onCheckedChange={setAcknowledged} required /><FieldLabel htmlFor={`${id}-review`}>Khi mở khiếu nại, Pawket sẽ xem tin nhắn và tệp riêng tư của đơn này để xem xét.</FieldLabel></CheckboxField>
    {invalid ? <StatusBanner tone="error">Kiểm tra trình bày và số tiền yêu cầu.</StatusBanner> : null}
    <ActionBar><Button type="submit" disabled={!acknowledged || disabled}>Mở khiếu nại</Button></ActionBar>
  </FieldGroup></FieldSet></form>;
}
export function DisputePanel({ dispute, role, disabled, onStatement, onWithdraw }: Readonly<{ dispute: NonNullable<ResolutionView["resolution"]["dispute"]>; role: "buyer" | "creator";
  disabled: boolean; onStatement(text: string): void; onWithdraw(): void }>) {
  const id = useId(); const [text, setText] = useState(""); const [withdraw, setWithdraw] = useState(false);
  const canWithdraw = dispute.statements.find((row) => row.kind === "opening")?.authorRole === role;
  const count = dispute.statements.filter((row) => row.authorRole === role).length;
  return <section className="flex min-w-0 flex-col gap-4" aria-label="Khiếu nại">
    <h3>{dispute.state === "open" ? "Khiếu nại đang được Pawket xem xét" : dispute.state === "ruled" ? "Khiếu nại đã có kết luận" : dispute.state === "withdrawn" ? "Đã rút khiếu nại" : "Khiếu nại đã kết thúc"}</h3>
    <SummaryList items={[{ label: "Lý do", value: reasonLabels[dispute.reason] }, ...(dispute.state === "open" ? [{ label: "Thời hạn", value: dispute.respondBy ? `Gửi phản hồi trước ${formatTipTime(dispute.respondBy)}` : "Thời hạn đang tạm dừng" }] : [])]} />
    <ol className="flex flex-col gap-3">{dispute.statements.map((row, index) => <li key={`${row.createdAt}:${index}`}><p className="text-sm text-muted-foreground">{row.authorRole === "owner" ? "Câu hỏi của Pawket" : row.authorRole === "buyer" ? "Người đặt" : "Nghệ sĩ"} · {formatTipTime(row.createdAt)}</p><p className="whitespace-pre-wrap wrap-anywhere">{row.text}</p></li>)}</ol>
    {dispute.ruling ? <section aria-label="Kết luận của Pawket"><h3>Kết luận của Pawket</h3><SummaryList items={[{ label: "Kết quả", value: dispute.ruling.outcome === "close" ? "Hủy đơn" : "Hoàn tất đơn" }, { label: "Số tiền hoàn", value: formatVnd(dispute.ruling.refundAmountVnd) }, { label: "Ngày kết luận", value: formatTipTime(dispute.ruling.ruledAt) }]} /><p className="whitespace-pre-wrap wrap-anywhere">{dispute.ruling.reasoning}</p></section> : null}
    {dispute.state === "open" ? <>
      <form onSubmit={(event) => { event.preventDefault(); if (!disabled && count < 10 && resolutionText(text, 4000)) onStatement(text); }}><FieldSet disabled={disabled || count >= 10}><FieldGroup><Field htmlFor={`${id}-text`} label="Bổ sung trình bày" hint={`${count}/10 lần trình bày; tối đa 4.000 ký tự.`}><Textarea id={`${id}-text`} value={text} onChange={(event) => setText(event.target.value)} /></Field><ActionBar><Button type="submit" disabled={!resolutionText(text, 4000)}>Bổ sung trình bày</Button></ActionBar></FieldGroup></FieldSet></form>
      {canWithdraw ? <ActionBar note="Rút khiếu nại sẽ cho phép đơn tiếp tục thực hiện hoặc duyệt bài."><Button variant="outline" disabled={disabled} onClick={() => setWithdraw(true)}>Rút khiếu nại</Button>{withdraw ? <Button disabled={disabled} onClick={onWithdraw}>Xác nhận rút khiếu nại</Button> : null}</ActionBar> : null}
    </> : null}
  </section>;
}
