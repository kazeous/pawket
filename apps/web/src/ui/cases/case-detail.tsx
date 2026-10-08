"use client";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FieldGroup } from "@/components/ui/field";
import { Field } from "../field";
import { EmptyState, LoadingState, RetryState } from "../async-state";
import { StatusBanner } from "../status-banner";
import { TipRequestError } from "../tips/tip-client";
import { resolutionText } from "../resolutions/resolution-client";
import { caseRequest, casePost, readCase, caseDetailSchema, caseErrorText, caseKindLabels, evidenceLabels, openCaseFile, formatTipTime, formatVnd, type CaseAction, type CaseDetailView, type EvidenceSection } from "./case-client";
import { EvidenceTabs } from "./evidence-tabs";
import { RulingForm } from "./ruling-form";
import { RefundCaseActions } from "./refund-case-actions";

const eventLabels: Record<string, string> = { opened: "Mở vụ việc", resolved: "Giải quyết vụ việc", question_posted: "Đặt câu hỏi", deadline_extended: "Gia hạn" };
const resolutionLabels: Record<string, string> = { ruled: "Đã kết luận", settled: "Hai bên đã thỏa thuận", withdrawn: "Đã rút", superseded: "Đã được thay thế", receipt_accepted: "Chấp nhận đã nhận tiền", resend_required: "Yêu cầu chuyển lại", waived: "Miễn nghĩa vụ", send_recorded: "Đã ghi nhận chuyển", extended: "Đã gia hạn", refund_owed: "Cần hoàn tiền", rejected: "Đã từ chối" };
const orderLabels: Record<string, string> = { requested: "Đã yêu cầu", quoted: "Đã báo giá", awaiting_payment: "Chờ thanh toán", in_progress: "Đang thực hiện", delivered: "Đã bàn giao", completed: "Đã hoàn tất", closed: "Đã đóng" };
type Attempt = { path: string; init: RequestInit; file: boolean };
export function CaseDetail({ caseId, actorUserId, initial }: Readonly<{ caseId: string; actorUserId: string; initial?: CaseDetailView }>) {
  const [detail, setDetail] = useState<CaseDetailView | null>(initial ?? null); const [loading, setLoading] = useState(initial === undefined); const [loadError, setLoadError] = useState(false);
  const [tab, setTab] = useState<"evidence" | "timeline" | "access">("evidence"); const [working, setWorking] = useState(false); const [epoch, setEpoch] = useState(0);
  const [locked, setLocked] = useState(false); const [clock, setClock] = useState(() => Date.now());
  const [notice, setNotice] = useState<{ tone: "success" | "warning" | "error"; text: string } | null>(null);
  const attempt = useRef<Attempt | null>(null); const inFlight = useRef(false);
  const load = useCallback(async () => {
    setLoading(true); setLoadError(false); setEpoch((value) => value + 1); setClock(Date.now());
    try { setDetail(readCase(caseDetailSchema, await caseRequest(`/api/v1/admin/cases/${caseId}`)).case); }
    catch { setDetail(null); setLoadError(true); } finally { setLoading(false); }
  }, [caseId]);
  useEffect(() => { if (initial !== undefined) return; const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [initial, load]);
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 30_000); return () => window.clearInterval(timer); }, []);
  function failure(error: unknown) { const code = error instanceof TipRequestError ? error.code : "dependency_unavailable"; setNotice({ tone: "error", text: caseErrorText(code) }); return code; }
  async function send() {
    if (inFlight.current || !attempt.current) return;
    inFlight.current = true; setWorking(true); setNotice(null); setEpoch((value) => value + 1);
    try {
      const current = attempt.current; const result = await caseRequest(current.path, current.init);
      if (current.file) openCaseFile(result);
      attempt.current = null; setLocked(false); setNotice({ tone: "success", text: current.file ? "Đã mở lượt tải tệp." : "Đã ghi nhận thao tác. Trạng thái hiện tại được hiển thị bên dưới." });
      await load();
    } catch (error) {
      const code = failure(error); if (code !== "dependency_unavailable") { attempt.current = null; setLocked(false); }
      if (code !== "OIDC_STEP_UP_REQUIRED") await load();
    } finally { inFlight.current = false; setWorking(false); }
  }
  function execute(path: string, payload: unknown, file = false) {
    if (inFlight.current || attempt.current) return;
    attempt.current = { path, init: casePost(payload, actorUserId), file }; setLocked(true); void send();
  }
  async function readEvidence(section: EvidenceSection, cursor?: number) {
    if (inFlight.current || attempt.current) throw new TipRequestError("dependency_unavailable");
    inFlight.current = true; setWorking(true); setNotice(null);
    try {
      const result = await caseRequest(`/api/v1/admin/cases/${caseId}/evidence`, casePost({ section, ...(cursor === undefined ? {} : { cursor }) }, actorUserId));
      if (!result || typeof result !== "object" || !("evidence" in result)) throw new TipRequestError("dependency_unavailable");
      // Refresh the access log without opening another evidence section.
      const updated = readCase(caseDetailSchema, await caseRequest(`/api/v1/admin/cases/${caseId}`)).case;
      setDetail(updated); if (updated.state !== "open") throw new TipRequestError("not_available");
      return result.evidence;
    } catch (error) { const code = failure(error); setEpoch((value) => value + 1); if (code !== "OIDC_STEP_UP_REQUIRED") await load(); throw error; }
    finally { inFlight.current = false; setWorking(false); }
  }
  if (loading) return <LoadingState label="Đang tải vụ việc…" />;
  if (loadError || !detail) return <RetryState title="Chưa mở được vụ việc" onRetry={() => void load()}><p>Vụ việc có thể không còn khả dụng hoặc phiên owner cần xác thực lại.</p></RetryState>;
  const disabled = working || locked;
  const action = (payload: CaseAction) => execute(`/api/v1/admin/cases/${caseId}/actions`, payload);
  return <div className="owner-workspace stack"><Link className="text-link" href="/admin/cases">Quay lại hàng đợi</Link>
    {notice ? <StatusBanner tone={notice.tone}><p>{notice.text}</p></StatusBanner> : null}
    {locked && !working ? <Button variant="outline" onClick={() => void send()}>Kiểm tra lại cùng yêu cầu</Button> : null}
    <section className="work-surface stack"><h2>{caseKindLabels[detail.kind]}</h2><dl className="summary-list">
      <div><dt>Đơn hàng</dt><dd className="mono break-all">{detail.orderId}</dd></div><div><dt>Trạng thái vụ việc</dt><dd>{detail.state === "open" ? "Đang mở" : "Đã giải quyết"}{detail.resolutionKind ? ` · ${resolutionLabels[detail.resolutionKind] ?? "Đã ghi nhận kết quả"}` : ""}</dd></div>
      <div><dt>Trạng thái đơn</dt><dd>{orderLabels[detail.orderState]}</dd></div><div><dt>Số tiền</dt><dd>{detail.amountVnd === null ? "Chưa chốt số tiền" : formatVnd(detail.amountVnd)}</dd></div>
      <div><dt>Mở lúc</dt><dd><time dateTime={detail.openedAt}>{formatTipTime(detail.openedAt)}</time></dd></div><div><dt>Phiên bản</dt><dd>{detail.version}</dd></div>
    </dl><Button variant="outline" disabled={working} onClick={() => void load()}>Tải lại vụ việc</Button></section>
    <section className="work-surface stack"><div className="owner-tabs" role="navigation" aria-label="Chi tiết vụ việc">
      {(["evidence", "timeline", "access"] as const).map((value) => <Button key={value} variant={tab === value ? "outline" : "ghost"} aria-pressed={tab === value} disabled={working} onClick={() => { setEpoch((current) => current + 1); setTab(value); }}>{value === "evidence" ? "Bằng chứng" : value === "timeline" ? "Lịch sử vụ việc" : "Nhật ký truy cập"}</Button>)}</div>
      {tab === "evidence" ? detail.state === "open" ? <EvidenceTabs key={`${detail.caseId}-${epoch}`} kind={detail.kind} disabled={disabled} onRead={readEvidence} onFile={(fileId) => execute(`/api/v1/admin/cases/${caseId}/files/${fileId}`, { disposition: "attachment" }, true)} /> : <EmptyState title="Vụ việc đã giải quyết; bằng chứng riêng tư đã đóng" /> : null}
      {tab === "timeline" ? <><h2>Lịch sử vụ việc</h2><ol className="stack">{detail.events.map((event) => <li key={event.id}><p>{eventLabels[event.action] ?? "Thao tác đã ghi nhận"} · <time dateTime={event.occurredAt}>{formatTipTime(event.occurredAt)}</time> · phiên bản {event.resultingVersion}</p>{event.reason ? <p className="whitespace-pre-wrap break-words">Lý do (chỉ owner thấy): {event.reason}</p> : null}</li>)}</ol></> : null}
      {tab === "access" ? <><h2>Nhật ký truy cập</h2><p className="muted">100 lượt truy cập gần nhất, chỉ owner thấy.</p>{detail.accessLog.length === 0 ? <EmptyState title="Chưa có lượt truy cập bằng chứng" /> : <ol className="stack">{detail.accessLog.map((entry) => <li key={entry.id}><p>{evidenceLabels[entry.itemType]} · <time dateTime={entry.accessedAt}>{formatTipTime(entry.accessedAt)}</time></p><p className="mono break-all">Owner {entry.ownerUserId} · phiên {entry.ownerSessionId} · mục {entry.itemId}</p></li>)}</ol>}</> : null}
    </section>
    {detail.kind === "dispute" && detail.state === "open" ? <section className="work-surface stack">{detail.amountVnd !== null ? <RulingForm key={`${detail.version}-${detail.orderState}`} orderState={detail.orderState} amountVnd={detail.amountVnd} disabled={disabled} onSubmit={action} /> : null}<DisputeActions detail={detail} disabled={disabled} onSubmit={action} clock={clock} /></section> : null}
    {detail.kind.startsWith("refund_") && detail.state === "open" ? <section className="work-surface"><RefundCaseActions kind={detail.kind as "refund_not_received" | "refund_overdue"} disabled={disabled} onSubmit={action} /></section> : null}
    {detail.kind === "late_payment" && detail.state === "open" ? <section className="work-surface"><LateClaimActions disabled={disabled} onSubmit={action} /></section> : null}
    {detail.ruling ? <section className="work-surface stack"><h2>Kết luận đã ghi nhận</h2><p>{detail.ruling.outcome === "complete" ? "Hoàn tất đơn" : "Đóng đơn"} · hoàn {formatVnd(detail.ruling.refundAmountVnd)} · {formatTipTime(detail.ruling.ruledAt)}</p>
      {detail.ruling.correctionEndsAt && clock <= Date.parse(detail.ruling.correctionEndsAt) ? <CorrectionForm detail={detail} disabled={disabled} onSubmit={action} /> : <p>Đính chính tiền hiện không khả dụng hoặc đã hết thời hạn 30 ngày.</p>}</section> : null}
    {detail.creatorStanding === "suspended" ? <section className="work-surface"><FreezeForm disabled={disabled} onSubmit={(reason) => execute(`/api/v1/admin/creators/${encodeURIComponent(detail.creatorUserId)}/freeze`, { reason })} /></section> : null}
  </div>;
}
function ReasonForm({ title, label = "Lý do", name = "reason", maximum = 2_000, disabled, children, onSubmit }: Readonly<{ title: string; label?: string; name?: string; maximum?: number; disabled: boolean; children?: React.ReactNode; onSubmit(reason: string, data: FormData): boolean | void }>) {
  const id = useId(); const [error, setError] = useState<string | null>(null);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget); const reason = String(data.get(name) ?? "").trim();
    if (disabled || !resolutionText(reason, maximum) || onSubmit(reason, data) === false) { setError("Kiểm tra lý do, số tiền và thời hạn trước khi xác nhận."); return; } setError(null);
  }
  return <form className="stack" onSubmit={submit}><h3>{title}</h3><FieldGroup>{children}<Field htmlFor={id} label={label} required error={error} hint={`1–${maximum.toLocaleString("vi-VN")} ký tự.`}><Textarea id={id} name={name} required disabled={disabled} /></Field></FieldGroup>{error ? <p role="alert">{error}</p> : null}<Button type="submit" disabled={disabled}>{title}</Button></form>;
}
function DisputeActions({ detail, disabled, onSubmit, clock }: Readonly<{ detail: CaseDetailView; disabled: boolean; onSubmit(action: CaseAction): void; clock: number }>) {
  const id = useId(); const maximum = detail.disputeOpenedAt ? new Date(Date.parse(detail.disputeOpenedAt) + 14 * 86_400_000) : null;
  return <><ReasonForm title="Gửi câu hỏi cho hai bên" label="Câu hỏi (hai bên sẽ thấy)" maximum={4_000} disabled={disabled} onSubmit={(text) => onSubmit({ action: "question", text })} />
    {maximum && maximum.getTime() > clock ? <ReasonForm title="Gia hạn phản hồi khiếu nại" disabled={disabled} onSubmit={(reason, data) => {
      const until = new Date(String(data.get("until"))); if (!Number.isFinite(until.getTime()) || until.getTime() <= Date.now() || until > maximum || detail.respondBy && until.getTime() <= Date.parse(detail.respondBy)) return false;
      onSubmit({ action: "extend", until: until.toISOString(), reason });
    }}><Field htmlFor={id} label="Hạn phản hồi mới" required hint={`Không quá ${formatTipTime(maximum.toISOString())}; giờ trên thiết bị của bạn.`}><Input id={id} name="until" type="datetime-local" required disabled={disabled} /></Field></ReasonForm> : <p>Đã hết cửa sổ gia hạn phản hồi khiếu nại.</p>}</>;
}
function CorrectionForm({ detail, disabled, onSubmit }: Readonly<{ detail: CaseDetailView; disabled: boolean; onSubmit(action: CaseAction): void }>) {
  const id = useId(); const ruling = detail.ruling!; const max = ruling.outcome === "complete" ? (detail.amountVnd ?? 0) - 1 : detail.amountVnd ?? 0;
  return <ReasonForm title="Đính chính số tiền hoàn" disabled={disabled} onSubmit={(reason, data) => {
    const value = Number(data.get("amount")); if (!Number.isSafeInteger(value) || value < 0 || value > max) return false;
    onSubmit({ action: "correct", rulingId: ruling.id, newRefundAmountVnd: value, reason });
  }}><p>Chỉ đổi số tiền; trạng thái kết thúc đơn và quyền tải tệp được giữ nguyên. Pawket không thu hồi khoản đã chuyển.</p><Field htmlFor={id} label="Tổng số tiền hoàn mới (VND)" required><Input id={id} name="amount" type="number" required step={1} min={0} max={max} defaultValue={ruling.refundAmountVnd} disabled={disabled} /></Field></ReasonForm>;
}
function LateClaimActions({ disabled, onSubmit }: Readonly<{ disabled: boolean; onSubmit(action: CaseAction): void }>) {
  const id = useId(); const [outcome, setOutcome] = useState<"refund_owed" | "rejected">("rejected");
  return <ReasonForm title="Kết luận thanh toán muộn" maximum={4_000} disabled={disabled} onSubmit={(reason, data) => {
    const amountVnd = Number(data.get("amount")); if (outcome === "refund_owed" && (!Number.isSafeInteger(amountVnd) || amountVnd < 1 || amountVnd > 50_000_000)) return false;
    onSubmit({ action: "rule_claim", outcome, reason, ...(outcome === "refund_owed" ? { amountVnd } : {}) });
  }}><Field htmlFor={id} label="Kết quả" required><select id={id} value={outcome} disabled={disabled} onChange={(event) => setOutcome(event.target.value as typeof outcome)}><option value="rejected">Từ chối yêu cầu</option><option value="refund_owed">Cần hoàn tiền</option></select></Field>
    {outcome === "refund_owed" ? <Field htmlFor={`${id}-amount`} label="Số tiền cần hoàn (VND)" required><Input id={`${id}-amount`} name="amount" type="number" min={1} max={50_000_000} step={1} required disabled={disabled} /></Field> : null}</ReasonForm>;
}
function FreezeForm({ disabled, onSubmit }: Readonly<{ disabled: boolean; onSubmit(reason: string): void }>) {
  const id = useId();
  return <ReasonForm title="Đóng băng thực hiện đơn" name="freezeReason" disabled={disabled} onSubmit={(reason, data) => { if (data.get("acknowledge") !== "on") return false; onSubmit(reason); }}>
    <p>Mọi đơn đã thanh toán đang thực hiện hoặc đã bàn giao của nghệ sĩ này sẽ đóng và phát sinh hoàn tiền toàn bộ. Các đơn đã đóng bằng thao tác này không thể khôi phục.</p>
    <Field htmlFor={id} label="Tôi đã kiểm tra và đồng ý đóng mọi đơn đang thực hiện của nghệ sĩ này" required><input id={id} name="acknowledge" type="checkbox" required disabled={disabled} /></Field>
  </ReasonForm>;
}
