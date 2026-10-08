"use client";
import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FieldGroup } from "@/components/ui/field";
import { Field } from "../field";
import { resolutionText } from "../resolutions/resolution-client";
import type { CaseAction } from "./case-client";
export const rulingChoices = { complete_none: "Hoàn tất, không hoàn tiền", complete_partial: "Hoàn tất, hoàn tiền một phần", close_full: "Đóng đơn, hoàn tiền toàn bộ", close_partial: "Đóng đơn, hoàn tiền một phần hoặc không hoàn" };
type Choice = keyof typeof rulingChoices;
export function rulingBounds(choice: Choice, amount: number) {
  if (choice === "complete_none") return { min: 0, max: 0 };
  if (choice === "close_full") return { min: amount, max: amount };
  return { min: choice === "complete_partial" ? 1 : 0, max: amount - 1 };
}
export function RulingForm({ orderState, amountVnd, disabled, onSubmit }: Readonly<{ orderState: string; amountVnd: number; disabled: boolean; onSubmit(action: CaseAction): void }>) {
  const id = useId(); const [choice, setChoice] = useState<Choice>(orderState === "delivered" ? "complete_none" : "close_full");
  const [error, setError] = useState<string | null>(null); const bounds = rulingBounds(choice, amountVnd);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget); const refundAmountVnd = Number(data.get("amount"));
    const reasoning = String(data.get("reasoning") ?? "").trim(); const internalNote = String(data.get("internalNote") ?? "").trim();
    if (disabled || choice.startsWith("complete") && orderState !== "delivered" || !Number.isSafeInteger(refundAmountVnd) || refundAmountVnd < bounds.min || refundAmountVnd > bounds.max
      || !resolutionText(reasoning, 4_000) || internalNote && !resolutionText(internalNote, 2_000)) { setError("Kiểm tra số tiền, kết quả và độ dài nội dung (kết luận 1–4.000, ghi chú tối đa 2.000 ký tự)."); return; }
    setError(null); onSubmit({ action: "rule", outcome: choice.startsWith("complete") ? "complete" : "close", refundAmountVnd, reasoning, ...(internalNote ? { internalNote } : {}) });
  }
  return <form className="stack" onSubmit={submit}><h2>Kết luận vụ việc</h2><p>Kết luận được gửi cho cả hai bên và chấm dứt đơn. Pawket ghi nhận nghĩa vụ hoàn tiền; nghệ sĩ tự chuyển tiền.</p>
    <FieldGroup><Field htmlFor={`${id}-outcome`} label="Kết quả" required><select id={`${id}-outcome`} name="outcome" value={choice} disabled={disabled} onChange={(event) => setChoice(event.target.value as Choice)}>
      {Object.entries(rulingChoices).map(([value, label]) => <option key={value} value={value} disabled={value.startsWith("complete") && orderState !== "delivered"}>{label}</option>)}</select></Field>
    <Field htmlFor={`${id}-amount`} label="Số tiền hoàn (VND)" required error={error}><Input key={choice} id={`${id}-amount`} name="amount" type="number" min={bounds.min} max={bounds.max} step={1} defaultValue={bounds.min} readOnly={bounds.min === bounds.max} required disabled={disabled} /></Field>
    <Field htmlFor={`${id}-reasoning`} label="Kết luận (hai bên sẽ thấy)" required hint="1–4.000 ký tự."><Textarea id={`${id}-reasoning`} name="reasoning" required disabled={disabled} /></Field>
    <Field htmlFor={`${id}-note`} label="Ghi chú nội bộ (chỉ owner thấy)" hint="Không bắt buộc, tối đa 2.000 ký tự."><Textarea id={`${id}-note`} name="internalNote" disabled={disabled} /></Field></FieldGroup>
    {error ? <p role="alert">{error}</p> : null}<Button type="submit" disabled={disabled}>Xác nhận kết luận</Button></form>;
}
