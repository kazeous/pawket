"use client";

import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { FieldGroup, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/ui/field";
import { ActionBar } from "@/ui/action-bar";
import { StatusBanner } from "@/ui/status-banner";
import { formatVnd } from "@/ui/tips/tip-client";
import type { OrderView } from "../commissions/commission-client";
import { proposalKinds, resolutionText } from "./resolution-client";

export function ProposalForm({ order, disabled, onSubmit }: Readonly<{ order: OrderView["order"]; disabled: boolean; onSubmit(payload: object): void }>) {
  const id = useId(); const [kind, setKind] = useState<(typeof proposalKinds)[number]>("cancel_with_refund");
  const [amount, setAmount] = useState(0); const [note, setNote] = useState(""); const [invalid, setInvalid] = useState(false);
  const paid = order.payment?.amountVnd ?? order.terms?.amountVnd ?? 0;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const complete = kind === "complete_with_refund";
    if (disabled || !Number.isInteger(amount) || amount < (complete ? 1 : 0) || amount > paid - (complete ? 1 : 0)
      || complete && order.state !== "delivered" || !resolutionText(note, 2000)) { setInvalid(true); return; }
    setInvalid(false); onSubmit({ expectedVersion: order.version, kind, refundAmountVnd: amount, note });
  }
  return <form onSubmit={submit}><FieldSet disabled={disabled}><FieldGroup>
    <Field htmlFor={`${id}-kind`} label="Loại đề nghị"><NativeSelect id={`${id}-kind`} value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
      <NativeSelectOption value="cancel_with_refund">Hủy đơn và hoàn {formatVnd(amount)}</NativeSelectOption>
      {order.state === "delivered" ? <NativeSelectOption value="complete_with_refund">Hoàn tất đơn và hoàn {formatVnd(amount)}</NativeSelectOption> : null}
    </NativeSelect></Field>
    <Field htmlFor={`${id}-amount`} label="Số tiền hoàn (VND)" hint={`Tối đa ${formatVnd(paid - (kind === "complete_with_refund" ? 1 : 0))}.`} required><Input id={`${id}-amount`} type="number" min={kind === "complete_with_refund" ? 1 : 0} max={paid - (kind === "complete_with_refund" ? 1 : 0)} step={1} value={amount} onChange={(event) => setAmount(Number(event.target.value))} required /></Field>
    <Field htmlFor={`${id}-note`} label="Lời nhắn cho bên kia" hint="1–2.000 ký tự." required><Textarea id={`${id}-note`} value={note} onChange={(event) => setNote(event.target.value)} required /></Field>
    {invalid ? <StatusBanner tone="error">Kiểm tra loại đề nghị, số tiền và lời nhắn.</StatusBanner> : null}
    <ActionBar note="Bên kia có 72 giờ để phản hồi. Pawket không tự chuyển tiền."><Button type="submit">Gửi đề nghị</Button></ActionBar>
  </FieldGroup></FieldSet></form>;
}
