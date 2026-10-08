"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { formatTipTime } from "@/ui/tips/tip-client";
import { closeLabels, commissionPath, commissionRead, messageResultSchema, orderResultSchema, parseCommission, quotesSchema, stateLabels, threadSchema, timelineSchema,
  type OrderView, type QuotesView, type ThreadView, type TimelineView } from "./commission-client";
import { CommandFeedback, useCommissionCommand, useCommissionSession } from "./commission-session";
import { CommissionTerms } from "./commission-terms";
import { AttachedFileList, ReferenceFilePicker } from "./reference-files";
import { SubmissionCard } from "./submission-card";

export function CommissionThread({ order, fulfillmentMode, disabled, reviewExpired, onRefresh }: Readonly<{
  order: OrderView["order"]; fulfillmentMode: "disabled" | "enabled"; disabled: boolean; reviewExpired: boolean; onRefresh(): Promise<void>;
}>) {
  const base = `/api/v1${commissionPath(order.role)}/${order.id}`; const verify = useCommissionSession();
  const [thread, setThread] = useState<ThreadView | null>(null); const [timeline, setTimeline] = useState<TimelineView | null>(null);
  const [quotes, setQuotes] = useState<QuotesView | null>(null); const [failed, setFailed] = useState(false); const [busy, setBusy] = useState(false); const [refreshIndex, setRefreshIndex] = useState(0);
  const alive = useRef(true); const paging = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let active = true; let running = false; let controller: AbortController | null = null; let timer: ReturnType<typeof setInterval> | undefined;
    async function read(refreshOrder: boolean) {
      if (!active || running || paging.current || document.visibilityState !== "visible") return;
      running = true; controller = new AbortController(); const signal = controller.signal;
      try {
        await verify(); if (signal.aborted) return;
        // A full page can contain fifty Unicode messages and their file metadata.
        const [messages, events] = await Promise.all([commissionRead(`${base}/thread?limit=50`, threadSchema, 2_097_152, signal), commissionRead(`${base}/timeline`, timelineSchema, 524_288, signal)]);
        await verify(); if (!active || signal.aborted) return;
        setThread((current) => {
          const gap = !current?.items.length || Math.max(...current.items.map((item) => item.sequence)) + 1 < Math.min(...messages.thread.items.map((item) => item.sequence));
          return { ...messages.thread, items: [...new Map([...(current?.items ?? []).map((item) => [item.sequence, item] as const), ...messages.thread.items.map((item) => [item.sequence, item] as const)]).values()],
            nextBeforeSequence: gap ? messages.thread.nextBeforeSequence : current?.nextBeforeSequence ?? null };
        });
        setTimeline((current) => {
          const gap = !current?.items.length || Math.max(...current.items.map((item) => item.version)) + 1 < Math.min(...events.history.items.map((item) => item.version));
          return { ...events.history, items: [...new Map([...(current?.items ?? []).map((item) => [item.version, item] as const), ...events.history.items.map((item) => [item.version, item] as const)]).values()],
            nextBeforeVersion: gap ? events.history.nextBeforeVersion : current?.nextBeforeVersion ?? null };
        });
        setFailed(false); if (refreshOrder && !signal.aborted) await onRefresh();
      } catch { if (active && !signal.aborted) setFailed(true); } finally { running = false; }
    }
    function visible() {
      clearInterval(timer);
      if (document.visibilityState !== "visible") { controller?.abort(); return; }
      void read(false);
      if (order.state !== "completed" && order.state !== "closed") timer = setInterval(() => void read(true), 15_000);
    }
    visible(); document.addEventListener("visibilitychange", visible);
    return () => { active = false; clearInterval(timer); controller?.abort(); document.removeEventListener("visibilitychange", visible); };
  }, [base, order.version, order.state, fulfillmentMode, verify, onRefresh, refreshIndex]);

  async function older(kind: "thread" | "timeline" | "quotes", before: number | null) {
    if (paging.current) return; paging.current = true; setBusy(true);
    try {
      await verify(); const path = `${base}/${kind}${before ? `?before=${before}` : ""}`;
      if (kind === "thread") { const result = await commissionRead(path, threadSchema, 2_097_152); await verify(); if (alive.current) setThread((current) => ({ ...result.thread, items: [...new Map([...(current?.items ?? []).map((item) => [item.sequence, item] as const), ...result.thread.items.map((item) => [item.sequence, item] as const)]).values()] })); }
      else if (kind === "timeline") { const result = await commissionRead(path, timelineSchema); await verify(); if (alive.current) setTimeline((current) => ({ ...result.history, items: [...new Map([...(current?.items ?? []).map((item) => [item.version, item] as const), ...result.history.items.map((item) => [item.version, item] as const)]).values()] })); }
      else { const result = await commissionRead(path, quotesSchema); await verify(); if (alive.current) setQuotes(result.history); }
      if (alive.current) setFailed(false);
    } catch { if (alive.current) setFailed(true); } finally { paging.current = false; if (alive.current) setBusy(false); }
  }
  const updated = () => { setRefreshIndex((current) => current + 1); void onRefresh(); };
  const enabled = fulfillmentMode === "enabled";
  const writable = enabled && !!thread?.writable && order.state !== "completed" && order.state !== "closed";
  const locked = disabled || failed || busy;
  const due = order.fulfillment?.completionDueAt;
  const deadlinePassed = reviewExpired || order.state === "delivered" && !due;
  const latestSubmission = Math.max(0, ...(thread?.items ?? []).filter((item) => item.kind === "submission").map((item) => item.sequence));
  const completionLabels: Record<string, string> = { buyer_accepted: "Người đặt đã chấp nhận", review_window_elapsed: "Tự hoàn tất khi hết hạn duyệt", agreement: "Hoàn tất theo thỏa thuận", ruling: "Hoàn tất theo kết luận của Pawket" };
  const closedAt = order.state === "closed" ? timeline?.items.find((event) => event.type === "closed")?.occurredAt : null;
  const entries = [
    ...(thread?.items ?? []).map((item) => ({ key: `thread:${item.sequence}`, at: item.kind === "message" ? item.createdAt : item.submittedAt, sequence: item.sequence, item })),
    ...(timeline?.items ?? []).map((event) => ({ key: `event:${event.version}`, at: event.occurredAt, sequence: Number.MAX_SAFE_INTEGER, event })),
  ].sort((left, right) => Date.parse(left.at) - Date.parse(right.at) || left.sequence - right.sequence || left.key.localeCompare(right.key));
  return <section className="flex min-w-0 flex-col gap-4" aria-label="Lịch sử đơn">
    <h2 className="text-xl font-semibold">Lịch sử</h2>
    <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => void older("quotes", null)}>Xem lịch sử báo giá</Button><Button variant="outline" disabled={busy} onClick={() => setRefreshIndex((current) => current + 1)}>Xem diễn biến đơn</Button></div>
    {!enabled ? <Alert><AlertDescription>Tạm dừng trao đổi và giao bài. Thời hạn duyệt sẽ được cộng thêm 48 giờ sau khi mở lại.</AlertDescription></Alert> : null}
    {order.state === "completed" ? <Alert><AlertDescription>Đơn đã hoàn tất. Cuộc trò chuyện chỉ còn để xem.</AlertDescription></Alert> : null}
    {order.state === "closed" ? <Alert><AlertDescription>Đơn đã đóng. Cuộc trò chuyện chỉ còn để xem.{closedAt ? ` Tệp dự kiến được xóa từ ${formatTipTime(new Date(Date.parse(closedAt) + 180 * 86_400_000).toISOString())}; có thể được giữ lâu hơn khi Pawket đang xem xét yêu cầu.` : ""}</AlertDescription></Alert> : null}
    {failed ? <Alert variant="destructive"><AlertTitle>Chưa tải được lịch sử</AlertTitle><AlertDescription>Vui lòng thử lại.</AlertDescription></Alert> : null}
    <ol className="flex min-w-0 flex-col gap-4">{entries.map((entry) => <li key={entry.key} className="min-w-0">
      {"event" in entry ? <p className="text-sm text-muted-foreground"><time dateTime={entry.at}>{formatTipTime(entry.at)}</time> · {stateLabels[entry.event.type as keyof typeof stateLabels] ?? (entry.event.type === "confirmed" ? "Đã xác nhận tiền" : "Đã cập nhật đơn")}{entry.event.reason ? ` · ${closeLabels[entry.event.reason] ?? completionLabels[entry.event.reason] ?? "Điều kiện đơn thay đổi"}` : ""}</p>
        : entry.item.kind === "submission" ? <SubmissionCard submission={{ ...entry.item, actionable: enabled && entry.item.actionable && !deadlinePassed && entry.item.sequence === latestSubmission }} order={order} disabled={locked} onUpdated={updated} />
          : <Card className="min-w-0"><CardHeader><CardTitle role="heading" aria-level={3}><Badge variant="outline">{entry.item.author === "creator" ? "nghệ sĩ" : "người đặt"}</Badge></CardTitle><CardDescription><time dateTime={entry.at}>{formatTipTime(entry.at)}</time></CardDescription></CardHeader>
            <CardContent className="flex min-w-0 flex-col gap-3">{entry.item.text ? <p data-message-text className="whitespace-pre-wrap wrap-anywhere">{entry.item.text}</p> : null}<AttachedFileList order={order} files={entry.item.files} withdrawn={order.state === "closed" && !!order.confirmedAt && order.role === "buyer" && entry.item.author === "creator"} /></CardContent></Card>}
    </li>)}</ol>
    <div className="flex flex-wrap gap-2">{thread?.nextBeforeSequence ? <Button variant="outline" disabled={busy} onClick={() => void older("thread", thread.nextBeforeSequence)}>Diễn biến cũ hơn</Button> : null}{timeline?.nextBeforeVersion ? <Button variant="outline" disabled={busy} onClick={() => void older("timeline", timeline.nextBeforeVersion)}>Xem diễn biến đơn</Button> : null}</div>
    {quotes ? <div className="flex flex-col gap-3">{quotes.items.length ? quotes.items.map((quote) => <Card key={quote.id}><CardHeader><CardTitle role="heading" aria-level={3}>Báo giá lần {quote.revisionNumber}</CardTitle><CardDescription>{formatTipTime(quote.issuedAt)} · Hạn {formatTipTime(quote.expiresAt)}</CardDescription></CardHeader><CardContent><CommissionTerms terms={quote.terms} /></CardContent></Card>) : <p>Chưa có báo giá riêng.</p>}{quotes.nextBeforeRevision ? <Button variant="outline" disabled={busy} onClick={() => void older("quotes", quotes.nextBeforeRevision)}>Báo giá cũ hơn</Button> : null}</div> : null}
    {writable ? <MessageComposer order={order} disabled={locked} onUpdated={updated} /> : null}
    {writable && order.role === "creator" && order.state === "in_progress" ? <div className="grid min-w-0 items-start gap-4 md:grid-cols-2">
      <SubmissionComposer kind="draft" order={order} disabled={locked} onUpdated={updated} /><SubmissionComposer kind="final" order={order} disabled={locked} onUpdated={updated} />
    </div> : null}
  </section>;
}

function MessageComposer({ order, disabled, onUpdated }: Readonly<{ order: OrderView["order"]; disabled: boolean; onUpdated(): void }>) {
  const id = useId(); const command = useCommissionCommand(); const [text, setText] = useState(""); const [files, setFiles] = useState({ fileIds: [] as string[], ready: true });
  const [picker, setPicker] = useState(0);
  const placeholder = order.role === "buyer" ? "Nhắn cho nghệ sĩ…" : "Nhắn cho người đặt…";
  const length = [...text.normalize("NFC").trim()].length; const ready = files.ready && length <= 4000 && (length > 0 || files.fileIds.length > 0);
  const locked = disabled || command.locked;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (locked || !ready) return;
    command.execute(`/api/v1${commissionPath(order.role)}/${order.id}/messages`, { text, fileIds: files.fileIds }, (value) => { parseCommission(messageResultSchema, value); setText(""); setPicker((current) => current + 1); onUpdated(); });
  }
  return <form aria-label={placeholder} onSubmit={submit}><FieldGroup><CommandFeedback command={command} />
    <Field data-disabled={locked || undefined}><FieldLabel htmlFor={`${id}-message`}>{placeholder}</FieldLabel><Textarea id={`${id}-message`} placeholder={placeholder} value={text} onChange={(event) => setText(event.target.value)} maxLength={8000} disabled={locked} /></Field>
    <ReferenceFilePicker key={picker} target={{ context: "thread", orderId: order.id }} maxFiles={10} maxBytes={26_214_400} disabled={locked} onChange={setFiles} />
    <Button type="submit" className="self-start" disabled={locked || !ready}>Gửi</Button>
  </FieldGroup></form>;
}

function SubmissionComposer({ kind, order, disabled, onUpdated }: Readonly<{ kind: "draft" | "final"; order: OrderView["order"]; disabled: boolean; onUpdated(): void }>) {
  const id = useId(); const command = useCommissionCommand(); const [note, setNote] = useState(""); const [files, setFiles] = useState({ fileIds: [] as string[], ready: true });
  const [picker, setPicker] = useState(0);
  const label = kind === "draft" ? "Bản nháp" : "Bản giao cuối"; const locked = disabled || command.locked;
  const ready = files.ready && files.fileIds.length >= 1 && [...note.normalize("NFC").trim()].length <= 2000;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (locked || !ready) return;
    command.execute(`/api/v1/creator/commissions/${order.id}/submissions`, { expectedVersion: order.version, kind, note, fileIds: files.fileIds }, (value) => {
      if (parseCommission(orderResultSchema, value).orderId !== order.id) throw new Error("Invalid commission result"); setNote(""); setPicker((current) => current + 1); onUpdated();
    });
  }
  return <form aria-label={label} onSubmit={submit}><FieldGroup><CommandFeedback command={command} />
    <ReferenceFilePicker key={picker} target={{ context: "submission", orderId: order.id }} maxFiles={20} maxBytes={262_144_000} label={label} disabled={locked} onChange={setFiles} />
    <Field data-disabled={locked || undefined}><FieldLabel htmlFor={`${id}-note`}>Lời nhắn (không bắt buộc)</FieldLabel><Textarea id={`${id}-note`} value={note} onChange={(event) => setNote(event.target.value)} maxLength={4000} disabled={locked} /></Field>
    <Button type="submit" className="self-start" disabled={locked || !ready}>Gửi</Button>
  </FieldGroup></form>;
}
