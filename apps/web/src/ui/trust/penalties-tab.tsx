"use client";
import Link from "next/link";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldGroup } from "@/components/ui/field";
import { Field } from "../field";
import { EmptyState, LoadingState, RetryState } from "../async-state";
import { StatusBanner } from "../status-banner";
import { caseRequest, readCase, formatTipTime } from "../cases/case-client";
import { ownerPenaltiesSchema, ownerText, penaltyKindLabels, penaltyTargetLabels, restrictionLabels, penaltyReasonLabels, type OwnerPenalty } from "./owner-trust-client";
import { useOwnerCommand } from "./use-owner-command";
export function PenaltiesTab({ actorUserId }: Readonly<{ actorUserId: string }>) {
  const [rows, setRows] = useState<OwnerPenalty[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState(false);
  const load = useCallback(async () => { setLoading(true); setError(false); try { setRows(readCase(ownerPenaltiesSchema, await caseRequest("/api/v1/admin/penalties?limit=100")).penalties); } catch { setError(true); } finally { setLoading(false); } }, []);
  const command = useOwnerCommand(actorUserId, load);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  return <section className="work-surface stack"><h2>Biện pháp đang có hiệu lực</h2>{command.notice ? <StatusBanner tone={command.notice.tone}><p>{command.notice.text}</p></StatusBanner> : null}
    {command.pending && !command.working ? <Button variant="outline" onClick={command.retry}>Kiểm tra lại cùng yêu cầu</Button> : null}
    {loading ? <LoadingState label="Đang tải biện pháp…" /> : error ? <RetryState title="Chưa tải được biện pháp" onRetry={() => void load()} /> : rows.length === 0 ? <EmptyState title="Không có biện pháp đang có hiệu lực" /> : rows.map((row) => <article className="stack" key={row.penaltyId}><h3>{penaltyKindLabels[row.kind]} · {row.subjectUserId}</h3>
      <p>{row.restriction ? restrictionLabels[row.restriction] : row.target ? penaltyTargetLabels[row.target] : "Cảnh cáo"} · {penaltyReasonLabels[row.reasonCategory]}</p><p className="whitespace-pre-wrap break-words">{row.explanation}</p>
      <p>Bắt đầu <time dateTime={row.startsAt}>{formatTipTime(row.startsAt)}</time> · {row.endsAt ? <>Kết thúc <time dateTime={row.endsAt}>{formatTipTime(row.endsAt)}</time></> : "Không có ngày kết thúc"}</p>
      {row.sourceCaseId ? <Link className="text-link" prefetch={false} href={`/admin/cases/${row.sourceCaseId}`}>Mở vụ việc nguồn</Link> : <Link className="text-link" href="/admin/content-reports">Mở báo cáo nội dung công khai</Link>}
      <LiftForm disabled={command.disabled} onSubmit={(reason) => command.submit(`/api/v1/admin/penalties/${row.penaltyId}/lift`, { reason })} /></article>)}
    {rows.length === 100 ? <p>Đang hiển thị 100 biện pháp đầu tiên.</p> : null}<Button variant="outline" disabled={command.disabled || loading} onClick={() => void load()}>Tải lại biện pháp</Button></section>;
}
function LiftForm({ disabled, onSubmit }: Readonly<{ disabled: boolean; onSubmit(reason: string): void }>) {
  const id = useId(); const [error, setError] = useState<string | null>(null);
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (disabled) return; const reason = ownerText(new FormData(event.currentTarget).get("reason"), 2_000, false); if (!reason) { setError("Nhập lý do 1–2.000 ký tự, không xuống dòng."); return; } setError(null); onSubmit(reason); }
  return <form className="stack" onSubmit={submit}><FieldGroup><Field htmlFor={id} label="Lý do gỡ biện pháp" required error={error}><Input id={id} name="reason" required disabled={disabled} /></Field></FieldGroup><p>Quyền sử dụng sẽ được tính lại theo các biện pháp còn hiệu lực. Các đơn đã đóng không được khôi phục.</p><Button type="submit" variant="outline" disabled={disabled}>Gỡ biện pháp</Button></form>;
}
