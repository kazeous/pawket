"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PaymentInstruction } from "@/ui/tips/payment-instruction";
import { formatTipTime, formatVnd } from "@/ui/tips/tip-client";
import { closeLabels, commissionPath, commissionRead, detailSchema, orderResultSchema, parseCommission, quotesSchema, routeLabels, stateLabels, timelineSchema, termsSchema,
  type OrderView, type QuotesView, type TermsView, type TimelineView } from "./commission-client";
import { CommandFeedback, useCommissionCommand, useCommissionSession } from "./commission-session";
import { Acceptance, CommissionTerms, TermsFields, termsFromForm } from "./commission-terms";

export function CommissionDetail({ initial }: Readonly<{ initial: OrderView }>) {
  const [view, setView] = useState(initial); const [loading, setLoading] = useState(false); const [failed, setFailed] = useState(false);
  const [close, setClose] = useState(false); const [accepted, setAccepted] = useState(false); const [localExpired, setLocalExpired] = useState(false);
  const command = useCommissionCommand(); const verify = useCommissionSession(); const order = view.order; const payment = order.payment;
  const base = `/api/v1${commissionPath(order.role)}/${order.id}`;
  useEffect(() => {
    if (!order.expiresAt) return;
    const deadline = Date.parse(order.expiresAt);
    const check = () => setLocalExpired(Date.now() >= deadline);
    const timer = setTimeout(check, Math.max(0, Math.min(deadline - Date.now(), 2_147_483_647)));
    document.addEventListener("visibilitychange", check);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", check); };
  }, [order.expiresAt]);
  async function refresh() {
    if (loading) return; setLoading(true);
    try { await verify(); const next = await commissionRead(base, detailSchema); await verify(); setView(next); setAccepted(false); setClose(false); setLocalExpired(next.order.deadlinePassed || (!!next.order.expiresAt && Date.now() >= Date.parse(next.order.expiresAt))); setFailed(false); }
    catch { setFailed(true); } finally { setLoading(false); }
  }
  const refreshResult = (value: unknown) => { const result = parseCommission(orderResultSchema, value); if (result.orderId !== order.id) throw new Error("Invalid commission result"); void refresh(); };
  const mutate = (action: string, data: object = {}) => command.execute(`${base}/${action}`, { expectedVersion: order.version, ...data }, refreshResult);
  const locked = command.locked || loading || failed;
  const expired = order.deadlinePassed || localExpired;
  const unpaid = ["requested", "quoted", "awaiting_payment"].includes(order.state);
  const mayAccept = (order.role === "buyer" && order.state === "quoted") || (order.role === "creator" && order.state === "requested" && order.route === "fixed_approval");
  const mayQuote = order.role === "creator" && order.route === "custom_quote" && ["requested", "quoted"].includes(order.state);
  const intake = view.controls.intakeMode === "enabled";
  const paymentEnabled = view.controls.paymentsMode !== "disabled";
  return <div className="flex min-w-0 flex-col gap-6">
    <header className="flex min-w-0 flex-col gap-3"><p className="eyebrow">{routeLabels[order.route]}</p><h1 className="wrap-anywhere">{order.package.title}</h1><div className="flex flex-wrap items-center gap-2"><Badge variant="secondary">{stateLabels[order.state]}</Badge>{order.overdue ? <Badge variant="outline">Đã quá hạn thực hiện</Badge> : null}<Button variant="outline" size="sm" disabled={command.locked || loading} onClick={() => void refresh()}>Cập nhật trạng thái</Button></div><p className="text-sm text-muted-foreground">Tạo lúc {formatTipTime(order.createdAt)} · giờ Việt Nam</p></header>
    <CommandFeedback command={command} />
    {failed ? <Alert variant="destructive"><AlertTitle>Chưa tải được trạng thái mới</AlertTitle><AlertDescription>Thao tác có thể đã được lưu. Kiểm tra lại trạng thái trước khi tiếp tục.<Button variant="outline" onClick={() => void refresh()}>Kiểm tra trạng thái</Button></AlertDescription></Alert> : null}
    {expired && unpaid ? <Alert><AlertTitle>Đã qua thời hạn</AlertTitle><AlertDescription>Không tiếp tục chuyển tiền theo hướng dẫn cũ. Hệ thống đang cập nhật trạng thái đóng đơn.</AlertDescription></Alert> : null}
    {!intake || !paymentEnabled ? <Alert><AlertTitle>Commission đang tạm giới hạn</AlertTitle><AlertDescription>{!intake ? "Tạm ngừng yêu cầu, báo giá và chốt đơn mới. " : ""}{!paymentEnabled ? "Thanh toán và xác nhận tiền đang tạm dừng. " : ""}Bạn vẫn xem được lịch sử. Thời hạn đơn không được gia hạn.</AlertDescription></Alert> : null}
    {order.state === "closed" ? <Alert><AlertTitle>{closeLabels[order.closeReason ?? ""] ?? "Đơn đã đóng"}</AlertTitle><AlertDescription>Đơn này không còn nhận thanh toán. Nếu đã chuyển tiền, liên hệ nghệ sĩ để đối chiếu. Trạng thái đóng không có nghĩa là đã hoàn tiền.</AlertDescription></Alert> : null}
    {order.state === "in_progress" ? <Alert><AlertTitle>Đã xác nhận thanh toán · đang thực hiện</AlertTitle><AlertDescription>{order.dueAt ? `Hạn thực hiện: ${formatTipTime(order.dueAt)}. ` : ""}Việc xác nhận tiền chưa đồng nghĩa commission đã hoàn tất.</AlertDescription></Alert> : null}
    <div className="grid min-w-0 items-start gap-6 lg:grid-cols-2">
      <Card className="min-w-0"><CardHeader><CardTitle role="heading" aria-level={2}>Brief đã gửi</CardTitle><CardDescription>Brief được giữ nguyên theo yêu cầu ban đầu.</CardDescription></CardHeader><CardContent className="flex min-w-0 flex-col gap-4"><p className="whitespace-pre-wrap wrap-anywhere">{order.brief.text}</p>{order.brief.referenceLinks.length ? <ul className="flex min-w-0 list-inside list-disc flex-col gap-2">{order.brief.referenceLinks.map((link, i) => <li key={link}><a href={link} target="_blank" rel="noopener noreferrer external" referrerPolicy="no-referrer" className="break-all text-sm underline">Tham khảo {i + 1}: {link}</a></li>)}</ul> : null}</CardContent></Card>
      <Card className="min-w-0"><CardHeader><CardTitle role="heading" aria-level={2}>{order.acceptedAt ? "Điều khoản đã chốt" : order.quote ? `Báo giá lần ${order.quote.revisionNumber}` : "Điều khoản gói đã chọn"}</CardTitle><CardDescription>{order.expiresAt && unpaid ? `Hạn phản hồi hoặc thanh toán: ${formatTipTime(order.expiresAt)}` : "Nội dung được lưu theo phiên bản của đơn."}</CardDescription></CardHeader><CardContent className="flex min-w-0 flex-col gap-5"><CommissionTerms terms={order.terms} policy={order.policy?.document} />
        {mayAccept && order.terms ? <div className="flex flex-col gap-3"><Acceptance checked={accepted} onChange={setAccepted} disabled={locked || expired || !intake || !paymentEnabled} /><Button disabled={locked || expired || !intake || !paymentEnabled || !accepted} onClick={() => mutate("accept", { quoteRevisionId: order.quote?.id ?? null, policyRevisionId: order.terms!.policyRevisionId, acceptTerms: true })}>{order.role === "creator" ? "Nhận yêu cầu và mở thanh toán" : "Chấp nhận báo giá và xem thanh toán"}</Button><p className="text-sm text-muted-foreground">Giữ một suất và mở hạn thanh toán 24 giờ sau khi chấp nhận thành công.</p></div> : null}
      </CardContent></Card>
    </div>
    {payment ? <Card><CardHeader><CardTitle role="heading" aria-level={2}>Thanh toán của đơn</CardTitle><CardDescription>{payment.state === "confirmed" ? "Đã xác nhận tiền" : payment.state === "awaiting_transfer" ? "Đang chờ tiền" : "Thanh toán đã kết thúc"} · {formatVnd(payment.amountVnd)}</CardDescription></CardHeader><CardContent className="flex min-w-0 flex-col gap-4">
      <p className="break-all">Nội dung chuyển khoản: <strong>{payment.reference}</strong></p>
      <p className="text-sm">{payment.confirmationSource === "creator_manual" ? "Nguồn xác nhận: nghệ sĩ tự đối chiếu và xác nhận đã nhận tiền." : payment.confirmationSource === "sepay_automatic" ? "Nguồn xác nhận: đối soát tự động từ SePay." : payment.confirmationSource === "creator_reviewed_sepay" ? "Nguồn xác nhận: nghệ sĩ duyệt giao dịch SePay đã khớp." : payment.settlementLane === "provider_bound" ? "Thanh toán được đối soát qua kết nối ngân hàng SePay." : "Nghệ sĩ sẽ đối chiếu giao dịch trên tài khoản ngân hàng."}</p>
      {payment.transferClaimedAt ? <p className="text-sm">Người đặt báo đã chuyển lúc {formatTipTime(payment.transferClaimedAt)}. Đây chưa phải xác nhận ngân hàng.</p> : null}
      {order.role === "creator" ? <dl className="grid min-w-0 gap-2 text-sm"><div><dt>Ngân hàng nhận của đơn</dt><dd>{payment.destination.bankName}</dd></div><div><dt>Tài khoản nhận của đơn</dt><dd className="break-all">{payment.destination.accountNumber} · {payment.destination.accountName}</dd></div></dl> : null}
      {order.role === "creator" && payment.state === "awaiting_transfer" && payment.settlementLane === "manual_attested" && !expired ? <ConfirmationForm key={payment.id} payment={payment} disabled={locked || !paymentEnabled} onConfirm={(payload) => command.execute(`${base}/confirm`, payload, (value) => {
        const result = parseCommission(z.object({ payment: z.object({ id: z.uuid(), orderId: z.uuid(), state: z.literal("confirmed"), reference: z.string(), amountVnd: z.number().int() }) }), value);
        if (result.payment.id !== payment.id || result.payment.orderId !== order.id || result.payment.reference !== payment.reference || result.payment.amountVnd !== payment.amountVnd) throw new Error("Invalid payment result"); void refresh();
      })} /> : null}
      {order.role === "creator" && payment.settlementLane === "provider_bound" ? <a href="/creator/tips/sepay" className="text-sm underline">Mở hàng đợi đối soát SePay</a> : null}
      {order.role === "buyer" && !payment.instruction && payment.state === "awaiting_transfer" ? <p>Hướng dẫn thanh toán hiện không khả dụng. Cập nhật trạng thái trước khi chuyển tiền.</p> : null}
    </CardContent></Card> : null}
    {order.role === "buyer" && payment?.instruction && !expired && !failed ? <PaymentInstruction key={payment.id} instruction={payment.instruction} footer={<div className="flex flex-col gap-3"><p>Báo đã chuyển không xác nhận tiền và không kéo dài thời hạn thanh toán.</p><Button disabled={locked || !!payment.transferClaimedAt} onClick={() => mutate("claim")}>{payment.transferClaimedAt ? "Đã báo chuyển khoản" : "Tôi đã chuyển khoản"}</Button></div>} /> : null}
    {mayQuote ? <QuoteForm key={`quote:${order.id}:${order.version}`} terms={order.terms} policy={order.currentPolicy} disabled={locked || expired || !intake} onQuote={(terms, ttlMs) => mutate("quote", { terms, ttlMs })} /> : null}
    {unpaid && !expired ? <section className="flex flex-col items-start gap-3"><Button variant="outline" disabled={locked} onClick={() => setClose(true)}>{order.role === "buyer" ? "Rút hoặc hủy yêu cầu" : "Từ chối hoặc hủy yêu cầu"}</Button>
      {close ? <Alert><AlertTitle>Đóng yêu cầu này?</AlertTitle><AlertDescription><p>{order.state === "awaiting_payment" ? "Chỉ đóng khi chưa được xác nhận tiền. Hướng dẫn thanh toán sẽ bị hủy và suất đang giữ được trả lại. Nếu đã chuyển tiền, cần liên hệ nghệ sĩ để đối chiếu; thao tác này không hoàn tiền." : "Yêu cầu và điều khoản được giữ trong lịch sử. Bạn không thể tiếp tục chốt đơn này sau khi đóng."}</p><div className="flex flex-wrap gap-2"><Button disabled={locked} onClick={() => mutate("close")}>Xác nhận đóng yêu cầu</Button><Button disabled={locked} variant="outline" onClick={() => setClose(false)}>Giữ yêu cầu</Button></div></AlertDescription></Alert> : null}
    </section> : null}
    <CommissionHistory key={`history:${order.id}:${order.version}`} base={base} />
    <a href={commissionPath(order.role)} className={buttonVariants({ variant: "outline", className: "self-start" })}>Về danh sách commission</a>
  </div>;
}
function QuoteForm({ terms, policy, disabled, onQuote }: Readonly<{ terms: TermsView | null; policy: OrderView["order"]["currentPolicy"]; disabled: boolean; onQuote(terms: TermsView, ttlMs: number): void }>) {
  const id = useId(); const [invalid, setInvalid] = useState(false); const [preview, setPreview] = useState<TermsView | null>(null); const [accepted, setAccepted] = useState(false); const [ttl, setTtl] = useState(168);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); const result = termsSchema.safeParse(termsFromForm(form, policy?.revisionId ?? "")); const hours = Number(form.get("ttl"));
    if (!result.success || Object.values(result.data).some((value) => typeof value === "string" && !value.trim()) || hours < 1 || hours > 336 || !Number.isInteger(hours)) { setInvalid(true); return; }
    setInvalid(false); setPreview(result.data); setAccepted(false); setTtl(hours);
  }
  return <Card><CardHeader><CardTitle role="heading" aria-level={2}>{terms ? "Thay báo giá" : "Soạn báo giá"}</CardTitle><CardDescription>Báo giá mới thay bản đang chờ. Người đặt cần xem và chấp nhận đúng bản mới; chưa giữ suất khi gửi báo giá.</CardDescription></CardHeader><CardContent className="flex flex-col gap-5">
    <form onSubmit={submit}><FieldSet disabled={disabled || !policy?.acceptsOrders}><TermsFields initial={terms} /><Field><FieldLabel htmlFor={`${id}-ttl`}>Thời hạn báo giá (giờ)</FieldLabel><Input id={`${id}-ttl`} name="ttl" type="number" min={1} max={336} step={1} defaultValue={168} required /><FieldDescription>1–336 giờ, mặc định 7 ngày; không vượt quá 30 ngày từ lúc gửi yêu cầu.</FieldDescription></Field><Button type="submit" className="self-start">Xem lại báo giá trước khi gửi</Button></FieldSet></form>
    {invalid ? <Alert variant="destructive"><AlertTitle>Báo giá chưa hợp lệ</AlertTitle><AlertDescription>Điền đủ các điều khoản và kiểm tra số tiền, thời hạn.</AlertDescription></Alert> : null}
    {!policy?.acceptsOrders ? <p>Chính sách hiện chưa cho phép gửi báo giá mới.</p> : null}
    {preview ? <section className="flex flex-col gap-4" aria-label="Xem lại báo giá"><CommissionTerms terms={preview} policy={policy?.document} /><p>Thời hạn đã chọn: {ttl} giờ, theo giới hạn thời gian của yêu cầu.</p><Acceptance checked={accepted} onChange={setAccepted} disabled={disabled} label="Tôi xác nhận nội dung báo giá hiển thị ở trên." /><Button disabled={disabled || !accepted} onClick={() => onQuote(preview, ttl * 3_600_000)}>Gửi báo giá đã xem</Button></section> : null}
  </CardContent></Card>;
}
function ConfirmationForm({ payment, disabled, onConfirm }: Readonly<{ payment: NonNullable<OrderView["order"]["payment"]>; disabled: boolean; onConfirm(payload: object): void }>) {
  const id = useId(); const firstField = useRef<HTMLInputElement>(null); const [attested, setAttested] = useState(false); const [invalid, setInvalid] = useState(false);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); const amount = String(form.get("amount")); const reference = String(form.get("reference")); const bankId = String(form.get("bankId")).trim();
    if (!/^\d+$/u.test(amount) || Number(amount) !== payment.amountVnd || reference !== payment.reference || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/u.test(bankId) || !attested) { setInvalid(true); firstField.current?.focus(); return; }
    setInvalid(false); onConfirm({ observedAmountVnd: Number(amount), observedTransferReference: reference, observedBankTransactionId: bankId, attestedReceived: true });
  }
  return <form onSubmit={submit}><FieldSet disabled={disabled}><h3 className="font-semibold">Đối chiếu tiền thực nhận</h3><p className="text-sm">Kiểm tra giao dịch đã vào đúng tài khoản nhận của đơn. Lời báo đã chuyển của người đặt chưa phải bằng chứng nhận tiền.</p><FieldGroup>
    <Field data-invalid={invalid || undefined}><FieldLabel htmlFor={`${id}-amount`}>Số tiền thực nhận (VND)</FieldLabel><Input ref={firstField} id={`${id}-amount`} name="amount" inputMode="numeric" autoComplete="off" maxLength={12} required aria-invalid={invalid} /></Field>
    <Field data-invalid={invalid || undefined}><FieldLabel htmlFor={`${id}-reference`}>Nội dung trên giao dịch ngân hàng</FieldLabel><Input id={`${id}-reference`} name="reference" autoComplete="off" spellCheck={false} maxLength={40} required aria-invalid={invalid} /></Field>
    <Field data-invalid={invalid || undefined}><FieldLabel htmlFor={`${id}-bankId`}>Mã giao dịch ngân hàng</FieldLabel><Input id={`${id}-bankId`} name="bankId" autoComplete="off" spellCheck={false} maxLength={100} required aria-invalid={invalid} /><FieldDescription>Mỗi giao dịch ngân hàng chỉ dùng để xác nhận một lần thanh toán.</FieldDescription>{invalid ? <FieldError>Kiểm tra số tiền, nội dung, mã giao dịch và lời xác nhận đã nhận tiền.</FieldError> : null}</Field>
    <Acceptance checked={attested} onChange={setAttested} disabled={disabled} label="Tôi đã kiểm tra đúng số tiền và nội dung đã vào tài khoản ngân hàng nhận của đơn này." /><Button type="submit" disabled={!attested} className="self-start">Xác nhận đã nhận tiền commission</Button>
  </FieldGroup></FieldSet></form>;
}
function CommissionHistory({ base }: Readonly<{ base: string }>) {
  const [quotes, setQuotes] = useState<QuotesView | null>(null); const [timeline, setTimeline] = useState<TimelineView | null>(null); const [busy, setBusy] = useState(false); const [failed, setFailed] = useState(false); const verify = useCommissionSession();
  async function load(kind: "quotes" | "timeline", before?: number | null) {
    if (busy) return; setBusy(true); setFailed(false);
    try { await verify(); const path = `${base}/${kind}${before ? `?before=${before}` : ""}`;
      if (kind === "quotes") { const result = await commissionRead(path, quotesSchema); await verify(); setQuotes(result.history); }
      else { const result = await commissionRead(path, timelineSchema); await verify(); setTimeline(result.history); }
    } catch { setFailed(true); } finally { setBusy(false); }
  }
  return <section className="flex min-w-0 flex-col gap-4" aria-label="Lịch sử đơn"><h2 className="text-xl font-semibold">Lịch sử</h2><div className="flex flex-wrap gap-2"><Button disabled={busy} variant="outline" onClick={() => void load("quotes")}>Xem lịch sử báo giá</Button><Button disabled={busy} variant="outline" onClick={() => void load("timeline")}>Xem diễn biến đơn</Button></div>
    {failed ? <Alert><AlertTitle>Chưa tải được lịch sử</AlertTitle><AlertDescription>Vui lòng thử lại.</AlertDescription></Alert> : null}
    {quotes ? <div className="flex flex-col gap-3">{quotes.items.length ? quotes.items.map((quote) => <Card key={quote.id}><CardHeader><CardTitle role="heading" aria-level={3}>Báo giá lần {quote.revisionNumber}</CardTitle><CardDescription>{formatTipTime(quote.issuedAt)} · Hạn {formatTipTime(quote.expiresAt)}</CardDescription></CardHeader><CardContent><CommissionTerms terms={quote.terms} /></CardContent></Card>) : <p>Chưa có báo giá riêng.</p>}{quotes.nextBeforeRevision ? <Button disabled={busy} variant="outline" onClick={() => void load("quotes", quotes.nextBeforeRevision)}>Báo giá cũ hơn</Button> : null}</div> : null}
    {timeline ? <div className="flex flex-col gap-3"><ol className="flex flex-col gap-2">{timeline.items.map((event) => <li key={event.version} className="text-sm"><time dateTime={event.occurredAt}>{formatTipTime(event.occurredAt)}</time> · {stateLabels[event.type as keyof typeof stateLabels] ?? (event.type === "confirmed" ? "Đã xác nhận tiền" : "Đã cập nhật đơn")}{event.reason ? ` · ${closeLabels[event.reason] ?? "Điều kiện đơn thay đổi"}` : ""}</li>)}</ol>{timeline.nextBeforeVersion ? <Button disabled={busy} variant="outline" onClick={() => void load("timeline", timeline.nextBeforeVersion)}>Diễn biến cũ hơn</Button> : null}</div> : null}
  </section>;
}
