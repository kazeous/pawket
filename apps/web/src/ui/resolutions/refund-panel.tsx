"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { z } from "zod";
import { QRCodeSVG } from "qrcode.react";
import { Button } from "@/components/ui/button";
import { FieldGroup, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { ActionBar } from "@/ui/action-bar";
import { Field } from "@/ui/field";
import { StatusBanner } from "@/ui/status-banner";
import { SummaryList } from "@/ui/summary-list";
import { formatTipTime, formatVnd } from "@/ui/tips/tip-client";
import { parseCommission, type OrderView } from "../commissions/commission-client";
import { CommandFeedback, useCommissionCommand } from "../commissions/commission-session";
import { ReferenceFilePicker } from "../commissions/reference-files";
import { refundStateLabels, resolutionPath, resolutionRequest, revealSchema, type RefundView } from "./resolution-client";
import { useResolutionDeadline } from "./resolution-deadline";

export function RefundPanel({ order, refund, banks = {}, disabled, onRefresh }: Readonly<{ order: OrderView["order"]; refund: RefundView;
  banks?: Readonly<Record<string, string>>; disabled: boolean; onRefresh(): Promise<void> }>) {
  const command = useCommissionCommand(resolutionRequest); const [revealed, setRevealed] = useState<z.infer<typeof revealSchema> | null>(null);
  const [changed, setChanged] = useState(false); const [confirm, setConfirm] = useState<boolean | null>(null);
  const receiptExpired = useResolutionDeadline(refund.confirmBy);
  const locked = disabled || command.locked; const path = (action: "enterDestination" | "confirmReceipt" | "reveal" | "recordSend") => resolutionPath(order.role, order.id, action, refund.obligationId);
  useEffect(() => {
    if (!command.code || command.locked) return;
    const timer = setTimeout(() => {
      // A destination correction may have changed the account. A new audited reveal is mandatory.
      if (command.code === "version_conflict") { setRevealed(null); setChanged(true); setConfirm(null); }
      void onRefresh();
    }, 0);
    return () => clearTimeout(timer);
  }, [command.code, command.locked, onRefresh]);
  function updated(value: unknown) { parseCommission(z.object({ version: z.number().int().positive() }), value); setRevealed(null); setConfirm(null); void onRefresh(); }
  return <section className="flex min-w-0 flex-col gap-4" aria-label="Hoàn tiền">
    <h3>Hoàn tiền · {formatVnd(refund.amountVnd)}</h3><CommandFeedback command={command} />
    <SummaryList items={[{ label: "Trạng thái", value: refundStateLabels[refund.state] }, { label: "Nội dung chuyển khoản", value: refund.reference },
      ...(refund.bankName ? [{ label: "Tài khoản nhận", value: `${refund.bankName} · …${refund.suffix ?? ""}` }] : []),
      { label: "Thời hạn", value: refund.dueAt ? `Hạn chuyển: ${formatTipTime(refund.dueAt)}` : refund.state === "awaiting_destination" ? "Chưa tính hạn khi chưa có tài khoản nhận." : "Thời hạn đang tạm dừng" }]} />
    {refund.sends.map((send) => <SummaryList key={send.id} items={[{ label: "Ngày chuyển", value: send.transferDate }, { label: "Mã giao dịch ngân hàng", value: send.bankReference }, ...(send.note ? [{ label: "Ghi chú", value: send.note }] : [])]} />)}
    {changed ? <StatusBanner tone="warning">Thông tin đã thay đổi. Xem lại thông tin chuyển hoàn tiền trước khi ghi nhận đã chuyển.</StatusBanner> : null}
    {order.role === "buyer" && ["awaiting_destination", "awaiting_send"].includes(refund.state) && !refund.hasRecordedSend ? <DestinationForm key={refund.version} banks={banks} disabled={locked} onSubmit={(payload) => command.execute(path("enterDestination"), { expectedVersion: refund.version, ...payload }, updated)} /> : null}
    {order.role === "buyer" && refund.state === "sent" ? <ActionBar note={refund.confirmBy ? `Phản hồi trước ${formatTipTime(refund.confirmBy)}. Sau hạn, hệ thống ghi nhận hết hạn xác nhận.` : "Thời hạn xác nhận đang tạm dừng."}>
      <Button disabled={locked || receiptExpired} onClick={() => setConfirm(true)}>Tôi đã nhận được tiền</Button>
      <Button variant="outline" disabled={locked || receiptExpired} onClick={() => setConfirm(false)}>Tôi chưa nhận được</Button>
      {confirm !== null ? <Button disabled={locked || receiptExpired} onClick={() => { if (!refund.confirmBy || Date.now() >= Date.parse(refund.confirmBy)) return; command.execute(path("confirmReceipt"), { expectedVersion: refund.version, received: confirm }, updated); }}>{confirm ? "Xác nhận đã nhận tiền" : "Xác nhận chưa nhận tiền"}</Button> : null}
    </ActionBar> : null}
    {order.role === "creator" && refund.state === "awaiting_send" ? <>
      <Button className="self-start" variant="outline" disabled={locked || !refund.dueAt} onClick={() => { setRevealed(null); command.execute(path("reveal"), {}, (value) => {
        const result = parseCommission(revealSchema, value); if (result.reference !== refund.reference || result.amountVnd !== refund.amountVnd) throw new Error("Invalid refund reveal");
        setRevealed(result); setChanged(false);
      }); }}>Xem thông tin chuyển hoàn tiền</Button>
      {revealed && command.code !== "version_conflict" ? <section className="flex min-w-0 flex-col gap-4" aria-label="Thông tin chuyển hoàn tiền">
        <QRCodeSVG value={revealed.qrPayload} title="Mã QR chuyển hoàn tiền" size={224} />
        <SummaryList items={[{ label: "Ngân hàng", value: revealed.bankName }, { label: "Số tài khoản", value: revealed.accountNumber }, { label: "Chủ tài khoản", value: revealed.accountHolder }, { label: "Số tiền", value: formatVnd(revealed.amountVnd) }, { label: "Nội dung chuyển khoản", value: revealed.reference }]} />
        <p>Pawket không tự chuyển tiền. Đối chiếu thông tin trên trước khi chuyển qua ngân hàng.</p>
        <SendForm key={refund.version} order={order} disabled={locked} createdAt={refund.createdAt} onSubmit={(payload) => command.execute(path("recordSend"), { expectedVersion: refund.version, ...payload }, updated)} />
      </section> : null}
    </> : null}
  </section>;
}
function DestinationForm({ banks, disabled, onSubmit }: Readonly<{ banks: Readonly<Record<string, string>>; disabled: boolean; onSubmit(payload: object): void }>) {
  const id = useId(); const [invalid, setInvalid] = useState(false);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (disabled) return; const form = new FormData(event.currentTarget); const bankBin = String(form.get("bank"));
    const accountNumber = String(form.get("account")).trim(); const accountHolder = String(form.get("holder")).normalize("NFC").trim();
    if (!Object.hasOwn(banks, bankBin) || !/^[0-9]{6,19}$/u.test(accountNumber) || !accountHolder || [...accountHolder].length > 100 || /[\p{Cc}\p{Cf}]/u.test(accountHolder)) { setInvalid(true); return; }
    setInvalid(false); onSubmit({ bankBin, accountNumber, accountHolder });
  }
  return <form onSubmit={submit}><FieldSet disabled={disabled}><FieldGroup><h4>Nhập tài khoản nhận hoàn tiền</h4>
    <StatusBanner>Pawket không kiểm tra được tài khoản này. Vui lòng nhập chính xác.</StatusBanner>
    <Field htmlFor={`${id}-bank`} label="Ngân hàng"><NativeSelect id={`${id}-bank`} name="bank">{Object.entries(banks).map(([bin, label]) => <NativeSelectOption key={bin} value={bin}>{label}</NativeSelectOption>)}</NativeSelect></Field>
    <Field htmlFor={`${id}-account`} label="Số tài khoản" required><Input id={`${id}-account`} name="account" inputMode="numeric" autoComplete="off" pattern="[0-9]{6,19}" required /></Field>
    <Field htmlFor={`${id}-holder`} label="Tên chủ tài khoản" required><Input id={`${id}-holder`} name="holder" autoComplete="off" required /></Field>
    {invalid ? <StatusBanner tone="error">Kiểm tra lại tài khoản nhận hoàn tiền.</StatusBanner> : null}
    <ActionBar note="Sửa tài khoản sẽ tính lại hạn chuyển. Không thể sửa sau khi đã ghi nhận chuyển."><Button type="submit">Lưu tài khoản nhận hoàn tiền</Button></ActionBar>
  </FieldGroup></FieldSet></form>;
}
export function SendForm({ order, createdAt, disabled, onSubmit }: Readonly<{ order: OrderView["order"]; createdAt: string; disabled: boolean; onSubmit(payload: object): void }>) {
  const id = useId(); const [files, setFiles] = useState({ fileIds: [] as string[], ready: true }); const [invalid, setInvalid] = useState(false);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const firstDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(createdAt));
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (disabled || !files.ready) return; const form = new FormData(event.currentTarget); const transferDate = String(form.get("date")); const bankReference = String(form.get("reference")).trim(); const note = String(form.get("note")).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(transferDate) || transferDate < firstDay || transferDate > today || !/^[A-Za-z0-9._/-]{1,64}$/u.test(bankReference) || [...note].length > 2000) { setInvalid(true); return; }
    setInvalid(false); onSubmit({ transferDate, bankReference, ...(note ? { note } : {}), fileIds: files.fileIds });
  }
  return <form onSubmit={submit}><FieldSet disabled={disabled}><FieldGroup>
    <Field htmlFor={`${id}-date`} label="Ngày chuyển" required><Input id={`${id}-date`} name="date" type="date" min={firstDay} max={today} required /></Field>
    <Field htmlFor={`${id}-reference`} label="Mã giao dịch ngân hàng" required><Input id={`${id}-reference`} name="reference" maxLength={64} autoComplete="off" required /></Field>
    <Field htmlFor={`${id}-note`} label="Ghi chú (không bắt buộc)"><Textarea id={`${id}-note`} name="note" /></Field>
    <ReferenceFilePicker target={{ context: "resolution_evidence", orderId: order.id }} maxFiles={3} maxBytes={26_214_400} label="Ảnh biên lai (không bắt buộc)" disabled={disabled} onChange={setFiles} />
    {invalid ? <StatusBanner tone="error">Kiểm tra ngày chuyển, mã giao dịch và ghi chú.</StatusBanner> : null}
    <ActionBar><Button type="submit" disabled={disabled || !files.ready}>Ghi nhận đã chuyển</Button></ActionBar>
  </FieldGroup></FieldSet></form>;
}
