"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { FieldGroup, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ActionBar } from "@/ui/action-bar";
import { Field } from "@/ui/field";
import { StatusBanner } from "@/ui/status-banner";
import { SummaryList } from "@/ui/summary-list";
import { formatTipTime, formatVnd } from "@/ui/tips/tip-client";
import { parseCommission, type OrderView } from "../commissions/commission-client";
import { CommandFeedback, useCommissionCommand } from "../commissions/commission-session";
import { ReferenceFilePicker } from "../commissions/reference-files";
import { claimStateLabels, resolutionPath, resolutionRequest, type ResolutionView } from "./resolution-client";
import { useResolutionDeadline } from "./resolution-deadline";

export function LateClaimPanel({ order, claim, disabled, onRefresh }: Readonly<{ order: OrderView["order"]; claim: ResolutionView["resolution"]["lateClaim"];
  disabled: boolean; onRefresh(): Promise<void> }>) {
  const id = useId(); const command = useCommissionCommand(resolutionRequest); const [open, setOpen] = useState(false); const [received, setReceived] = useState<boolean | null>(null);
  const [files, setFiles] = useState({ fileIds: [] as string[], ready: true }); const [invalid, setInvalid] = useState(false);
  const locked = disabled || command.locked;
  const answerExpired = useResolutionDeadline(claim?.creatorRespondBy);
  useEffect(() => { if (command.code && !command.locked) { const timer = setTimeout(() => void onRefresh(), 0); return () => clearTimeout(timer); } }, [command.code, command.locked, onRefresh]);
  function changed(value: unknown) { parseCommission(z.object({ claimId: z.uuid() }), value); setOpen(false); setReceived(null); void onRefresh(); }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (locked || !files.ready) return; const form = new FormData(event.currentTarget); const transferAt = new Date(String(form.get("at")));
    const amountVnd = Number(form.get("amount")); const bankReference = String(form.get("reference")).trim(); const note = String(form.get("note")).trim();
    if (!Number.isFinite(transferAt.getTime()) || transferAt.getTime() > Date.now() || !Number.isInteger(amountVnd) || amountVnd < 1 || amountVnd > 50_000_000 || !/^[A-Za-z0-9._/-]{1,64}$/u.test(bankReference) || [...note].length > 2000) { setInvalid(true); return; }
    setInvalid(false); command.execute(resolutionPath(order.role, order.id, "fileLateClaim"), { transferAt: transferAt.toISOString(), amountVnd, bankReference, ...(note ? { note } : {}), fileIds: files.fileIds }, changed);
  }
  return <section className="flex min-w-0 flex-col gap-4" aria-label="Chuyển khoản sau khi đơn đóng"><CommandFeedback command={command} />
    {claim ? <>
      <h3>Chuyển khoản sau khi đơn đóng</h3><SummaryList items={[{ label: "Trạng thái", value: claimStateLabels[claim.state] }, { label: "Số tiền đã báo", value: formatVnd(claim.claimedAmountVnd) }, { label: "Thời điểm chuyển", value: formatTipTime(claim.transferAt) }, { label: "Mã giao dịch ngân hàng", value: claim.bankReference },
        ...(claim.creatorRespondBy && claim.state === "awaiting_creator" ? [{ label: "Thời hạn", value: `Gửi phản hồi trước ${formatTipTime(claim.creatorRespondBy)}` }] : []), ...(claim.receivedAmountVnd !== null ? [{ label: "Số tiền thực nhận", value: formatVnd(claim.receivedAmountVnd) }] : [])]} />
      {claim.note ? <p className="whitespace-pre-wrap wrap-anywhere">{claim.note}</p> : null}
      {order.role === "creator" && claim.state === "awaiting_creator" ? <form onSubmit={(event) => {
        event.preventDefault(); if (locked || received === null || !claim.creatorRespondBy || Date.now() >= Date.parse(claim.creatorRespondBy)) return;
        const actual = Number(new FormData(event.currentTarget).get("actual"));
        if (received && (!Number.isInteger(actual) || actual < 1 || actual > 50_000_000)) { setInvalid(true); return; }
        command.execute(resolutionPath(order.role, order.id, "answerLateClaim", claim.id), { received, ...(received ? { receivedAmountVnd: actual } : {}) }, changed);
      }}><FieldSet disabled={locked || answerExpired}><FieldGroup>
        <ActionBar><Button type="button" variant="outline" onClick={() => setReceived(true)} aria-pressed={received === true}>Đã nhận tiền</Button><Button type="button" variant="outline" onClick={() => setReceived(false)} aria-pressed={received === false}>Chưa nhận tiền</Button></ActionBar>
        {received ? <Field htmlFor={`${id}-actual`} label="Số tiền thực nhận (VND)" required><Input id={`${id}-actual`} name="actual" type="number" min={1} max={50_000_000} step={1} required /></Field> : null}
        <p>{received === true ? "Xác nhận sẽ tạo khoản hoàn toàn bộ số tiền thực nhận; đơn không được mở lại." : "Chưa nhận tiền sẽ chuyển yêu cầu cho Pawket xem xét."}</p>
        {invalid ? <StatusBanner tone="error">Kiểm tra số tiền thực nhận.</StatusBanner> : null}
        <Button type="submit" className="self-start" disabled={received === null}>Xác nhận đối chiếu</Button>
      </FieldGroup></FieldSet></form> : null}
    </> : order.role === "buyer" ? <>
      <Button variant="outline" className="self-start" disabled={locked} onClick={() => setOpen(true)}>Tôi đã chuyển khoản sau khi đơn đóng</Button>
      {open ? <form onSubmit={submit}><FieldSet disabled={locked}><FieldGroup>
        <StatusBanner>Chỉ gửi một yêu cầu trong 30 ngày sau khi đơn đóng. Đơn không được mở lại; nghệ sĩ có 5 ngày để đối chiếu.</StatusBanner>
        <Field htmlFor={`${id}-at`} label="Thời điểm chuyển" hint="Theo múi giờ trên thiết bị của bạn." required><Input id={`${id}-at`} name="at" type="datetime-local" required /></Field>
        <Field htmlFor={`${id}-amount`} label="Số tiền đã chuyển (VND)" required><Input id={`${id}-amount`} name="amount" type="number" min={1} max={50_000_000} step={1} required /></Field>
        <Field htmlFor={`${id}-reference`} label="Mã giao dịch ngân hàng" required><Input id={`${id}-reference`} name="reference" maxLength={64} autoComplete="off" required /></Field>
        <Field htmlFor={`${id}-note`} label="Ghi chú (không bắt buộc)"><Textarea id={`${id}-note`} name="note" /></Field>
        <ReferenceFilePicker target={{ context: "resolution_evidence", orderId: order.id }} maxFiles={3} maxBytes={26_214_400} label="Ảnh biên lai (không bắt buộc)" disabled={locked} onChange={setFiles} />
        {invalid ? <StatusBanner tone="error">Kiểm tra thời điểm chuyển, số tiền, mã giao dịch và ghi chú.</StatusBanner> : null}
        <ActionBar><Button type="submit" disabled={locked || !files.ready}>Gửi yêu cầu đối chiếu</Button></ActionBar>
      </FieldGroup></FieldSet></form> : null}
    </> : null}
  </section>;
}
