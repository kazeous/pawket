"use client";
import Link from "next/link";
import { useCallback, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { Field } from "../field";
import { EmptyState, LoadingState, RetryState } from "../async-state";
import { StatusBanner } from "../status-banner";
import { caseAge, caseKindLabels, caseRequest, queueSchema, agingSchema, readCase, formatTipTime, formatVnd, type CaseQueueRow, type CaseKind, type AgingRefund } from "./case-client";

export function CaseQueue({ initialCases, now = new Date() }: Readonly<{ initialCases?: readonly CaseQueueRow[]; now?: Date }>) {
  const id = useId(); const [tab, setTab] = useState<"queue" | "aging">("queue");
  const [rows, setRows] = useState<readonly CaseQueueRow[]>(initialCases ?? []); const [refunds, setRefunds] = useState<readonly AgingRefund[]>([]);
  const [state, setState] = useState<"open" | "resolved">("open"); const [kind, setKind] = useState<CaseKind | "">("");
  const [age, setAge] = useState("all"); const [deadline, setDeadline] = useState("all");
  const [loading, setLoading] = useState(initialCases === undefined); const [error, setError] = useState(false); const [more, setMore] = useState(false);
  const load = useCallback(async (before?: { openedAt: string; id: string }) => {
    setLoading(true); setError(false);
    try {
      if (tab === "aging") setRefunds(readCase(agingSchema, await caseRequest("/api/v1/admin/refunds/aging")).refunds);
      else {
        const query = new URLSearchParams({ state, limit: "100" }); if (kind) query.set("kind", kind);
        if (before) { query.set("beforeOpenedAt", before.openedAt); query.set("beforeId", before.id); }
        const next = readCase(queueSchema, await caseRequest(`/api/v1/admin/cases?${query}`)).cases;
        setRows((current) => before ? [...current, ...next] : next); setMore(next.length === 100);
      }
    } catch { setError(true); } finally { setLoading(false); }
  }, [kind, state, tab]);
  useEffect(() => { if (initialCases !== undefined && tab === "queue" && kind === "" && state === "open") return;
    const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer);
  }, [initialCases, kind, state, tab, load]);
  const visible = rows.filter((row) => (age === "all" || caseAge(row.openedAt, now) >= Number(age))
    && (deadline === "all" || deadline === "none" && row.nextDeadline === null || deadline === "overdue" && row.nextDeadline !== null && Date.parse(row.nextDeadline) <= now.getTime()));
  return <div className="owner-workspace stack">
    <div className="owner-tabs" role="navigation" aria-label="Khiếu nại và hoàn tiền"><Button variant={tab === "queue" ? "outline" : "ghost"} aria-pressed={tab === "queue"} onClick={() => { setTab("queue"); setError(false); }}>Hàng đợi vụ việc</Button>
      <Button variant={tab === "aging" ? "outline" : "ghost"} aria-pressed={tab === "aging"} onClick={() => setTab("aging")}>Hoàn tiền chờ tài khoản</Button>
      <Link className="text-link" href="/admin/content-reports">Báo cáo nội dung công khai</Link></div>
    {tab === "queue" ? <section className="work-surface stack"><h2>Vụ việc cần xem xét</h2><FieldGroup>
      <Field htmlFor={`${id}-state`} label="Trạng thái"><select id={`${id}-state`} value={state} onChange={(event) => { setRows([]); setState(event.target.value as "open" | "resolved"); }}><option value="open">Đang mở</option><option value="resolved">Đã giải quyết</option></select></Field>
      <Field htmlFor={`${id}-kind`} label="Loại vụ việc"><select id={`${id}-kind`} value={kind} onChange={(event) => { setRows([]); setKind(event.target.value as CaseKind | ""); }}><option value="">Tất cả</option>{Object.entries(caseKindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
      <Field htmlFor={`${id}-age`} label="Tuổi vụ việc"><select id={`${id}-age`} value={age} onChange={(event) => setAge(event.target.value)}><option value="all">Tất cả</option><option value="7">Từ 7 ngày</option><option value="30">Từ 30 ngày</option></select></Field>
      <Field htmlFor={`${id}-deadline`} label="Hạn tiếp theo"><select id={`${id}-deadline`} value={deadline} onChange={(event) => setDeadline(event.target.value)}><option value="all">Tất cả</option><option value="overdue">Đã đến hạn</option><option value="none">Không có hạn đang chạy</option></select></Field></FieldGroup>
      <p className="muted">Bộ lọc tuổi và hạn áp dụng cho các vụ việc đã tải. Tải thêm để xem các vụ việc cũ hơn.</p>
      {loading ? <LoadingState label="Đang tải vụ việc…" /> : error ? <RetryState title="Chưa tải được hàng đợi" onRetry={() => void load()} /> : visible.length === 0 ? <EmptyState title="Không có vụ việc phù hợp" /> : <div className="queue-list">{visible.map((row) => <article className="queue-item stack compact" key={row.caseId}>
        <h3>{caseKindLabels[row.kind]}</h3><p className="mono break-all">Đơn {row.orderId}</p><p>{caseAge(row.openedAt, now)} ngày · {row.state === "open" ? "Đang mở" : "Đã giải quyết"}</p>
        <p>Hạn tiếp theo: {row.nextDeadline ? <time dateTime={row.nextDeadline}>{formatTipTime(row.nextDeadline)}</time> : "Không có hạn đang chạy"}</p>
        <Link className="text-link" href={`/admin/cases/${row.caseId}`} prefetch={false}>Mở vụ việc</Link></article>)}</div>}
      <div className="button-row"><Button variant="outline" disabled={loading} onClick={() => void load()}>Tải lại hàng đợi</Button>{more && rows.length > 0 ? <Button variant="outline" disabled={loading} onClick={() => { const last = rows.at(-1)!; void load({ openedAt: last.openedAt, id: last.caseId }); }}>Tải thêm vụ việc</Button> : null}</div>
    </section> : <section className="work-surface stack"><h2>Hoàn tiền chờ tài khoản</h2><p>Các khoản đã chờ tài khoản nhận hoàn tiền ít nhất 30 ngày. Chưa có thời hạn chuyển tiền khi người mua chưa nhập tài khoản.</p>
      {loading ? <LoadingState label="Đang tải khoản hoàn tiền…" /> : error ? <RetryState title="Chưa tải được khoản hoàn tiền" onRetry={() => void load()} /> : refunds.length === 0 ? <EmptyState title="Không có khoản hoàn tiền chờ tài khoản" /> : refunds.map((row, index) => <article className="item-row" key={`${row.orderId}-${index}`}><div><p className="mono break-all">Đơn {row.orderId}</p><p>{formatVnd(row.amountVnd)} · {row.ageDays} ngày</p></div></article>)}
      {refunds.length === 50 ? <StatusBanner tone="info"><p>Đang hiển thị 50 khoản lâu nhất.</p></StatusBanner> : null}<Button variant="outline" disabled={loading} onClick={() => void load()}>Tải lại khoản hoàn tiền</Button></section>}
  </div>;
}
