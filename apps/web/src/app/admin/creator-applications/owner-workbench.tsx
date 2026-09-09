"use client";

import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import { EmptyState, LoadingState, RetryState } from "../../../ui/async-state";
import { Field } from "../../../ui/field";
import { StatusBanner, StatusTag } from "../../../ui/status-banner";
import { SummaryList } from "../../../ui/summary-list";
import { ownerActionMessage, reconciliationNotice } from "./owner-feedback";

type QueueItem = { id: string; state: string; version: number; claimExpiresAt: string | null; claimedByCurrentOwner: boolean; submittedAt: string; artistDisplayName: string | null; primaryArtDiscipline: string | null; emailVerified: boolean; ageEligible: boolean; bankName: string | null; maskedSuffix: string | null; proofState: string | null };
type Detail = { application: { id: string; creatorUserId: string; state: string; version: number; currentRevisionId: string }; revision: { id: string; artistDisplayName: string; shortIntroduction: string; applicantEmail: string; dateOfBirth: string; portfolioUrls: string[]; primaryArtDiscipline: string; practiceDescription: string; contentIntent: string; ageAtSubmission: number; submittedAt: string }; attestations: Array<{ type: string; policyVersion: string }>; priorOutcomes: Array<{ action: string; reasonCode: string; createdAt: string }>; payment: { receivingAccountVersionId: string | null; challengeId: string | null; refundObligationId: string | null; bankName: string | null; maskedSuffix: string | null; proofState: string; refundState: string | null; refundNotBefore: string | null; refundDue: string | null } };
type Capability = { userId: string; artistDisplayName: string | null; state: string; version: number; approvedApplicationId: string; suspendedAt: string | null; updatedAt: string };
type Obligation = { id: string; applicantUserId: string; artistDisplayName: string | null; amountVnd: number; bankName: string; maskedSuffix: string; refundNotBefore: string; refundDue: string; state: string; updatedAt: string };
type IssuedChallenge = { id: string; amountVnd: number; reference: string; expiresAt: string; operatingAccount: { bankName: string; accountNumber: string; accountHolderLabel: string } };
type Tab = "queue" | "refunds" | "capabilities" | "reconcile";

class OwnerApiError extends Error { constructor(readonly code: string) { super(code); } }

async function api(path: string, init?: RequestInit) {
  const response = await fetch(path, { credentials: "include", cache: "no-store", ...init });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new OwnerApiError(typeof payload.code === "string" ? payload.code : "OWNER_ACTION_FAILED");
  return payload;
}

function post(body: Record<string, unknown>, extra?: HeadersInit): RequestInit { return { method: "POST", headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) }; }
export function OwnerWorkbench() {
  const [tab, setTab] = useState<Tab>("queue");
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [obligations, setObligations] = useState<Obligation[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [destination, setDestination] = useState<{ obligationId: string; data: Record<string, unknown> } | null>(null);
  const [issuedChallenge, setIssuedChallenge] = useState<IssuedChallenge | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error" | "warning"; text: string } | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const pendingAction = useRef<(() => Promise<void>) | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const load = useCallback(async () => {
    setLoading(true); setLoadError(false);
    try {
      const [queuePayload, capabilityPayload, refundPayload] = await Promise.all([api("/api/v1/admin/creator-applications"), api("/api/v1/admin/creator-capabilities"), api("/api/v1/admin/refund-obligations")]);
      setQueue(Array.isArray(queuePayload.applications) ? queuePayload.applications as QueueItem[] : []);
      setCapabilities(Array.isArray(capabilityPayload.capabilities) ? capabilityPayload.capabilities as Capability[] : []);
      setObligations(Array.isArray(refundPayload.obligations) ? refundPayload.obligations as Obligation[] : []);
    } catch { setLoadError(true); } finally { setLoading(false); }
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  useEffect(() => { if (stepUpOpen) dialogRef.current?.showModal(); else dialogRef.current?.close(); }, [stepUpOpen]);

  async function run(action: () => Promise<void>) {
    setWorking(true); setNotice(null);
    try { await action(); }
    catch (error) {
      if (error instanceof OwnerApiError && error.code === "OWNER_TOTP_REQUIRED") { pendingAction.current = action; setStepUpOpen(true); return; }
      setNotice({ tone: "error", text: ownerActionMessage(error instanceof OwnerApiError ? error.code : "OWNER_ACTION_FAILED") });
      if (error instanceof OwnerApiError && error.code === "STALE_VERSION") void load();
    } finally { setWorking(false); }
  }

  async function openApplication(item: QueueItem) {
    setWorking(true); setNotice(null);
    let version = item.version;
    try {
      if (!item.claimedByCurrentOwner) {
        const claimed = await api(`/api/v1/admin/creator-applications/${item.id}/claim`, post({}, { "if-match": String(item.version) }));
        version = ((claimed.claim as { version?: number })?.version ?? version);
      }
    } catch (error) {
      setNotice({ tone: "error", text: ownerActionMessage(error instanceof OwnerApiError ? error.code : "OWNER_ACTION_FAILED") });
      await load();
      setWorking(false);
      return;
    }
    setWorking(false);
    const action = async () => {
      const payload = await api(`/api/v1/admin/creator-applications/${item.id}/detail`, post({}));
      const next = payload.detail as Detail;
      setIssuedChallenge(null);
      setDetail({ ...next, application: { ...next.application, version } });
      setNotice({ tone: "success", text: "Hồ sơ đã được claim và mở trong workspace riêng tư." });
      await load();
    };
    return run(action);
  }

  function decide(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!detail) return;
    const values = new FormData(event.currentTarget); const idempotencyKey = crypto.randomUUID();
    const action = async () => { await api(`/api/v1/admin/creator-applications/${detail.application.id}/decision`, post({ revisionId: detail.application.currentRevisionId, action: values.get("action"), reasonCode: values.get("reasonCode"), applicantExplanation: values.get("applicantExplanation"), ...(values.get("privateNote") ? { privateNote: values.get("privateNote") } : {}) }, { "idempotency-key": idempotencyKey, "if-match": String(detail.application.version) })); setDetail(null); setIssuedChallenge(null); setNotice({ tone: "success", text: "Đã ghi nhận quyết định và audit event." }); await load(); };
    return run(action);
  }

  function issueChallenge() {
    if (!detail?.payment.receivingAccountVersionId) return; const idempotencyKey = crypto.randomUUID();
    const action = async () => {
      const payload = await api(`/api/v1/admin/creator-applications/${detail.application.id}/deposit/challenge`, post({ revisionId: detail.application.currentRevisionId, accountVersionId: detail.payment.receivingAccountVersionId }, { "idempotency-key": idempotencyKey }));
      const challenge = payload.challenge as Partial<IssuedChallenge>;
      const challengeId = challenge.id;
      if (typeof challengeId !== "string") throw new OwnerApiError("OWNER_ACTION_FAILED");
      setDetail((current) => current ? { ...current, payment: { ...current.payment, challengeId, proofState: "issued" } } : current);
      if (typeof challenge.reference === "string" && challenge.reference.length > 0 && typeof challenge.amountVnd === "number" && typeof challenge.expiresAt === "string" && challenge.operatingAccount) {
        setIssuedChallenge({ id: challengeId, amountVnd: challenge.amountVnd, reference: challenge.reference, expiresAt: challenge.expiresAt, operatingAccount: challenge.operatingAccount });
        setNotice({ tone: "warning", text: "Thử thách đã phát hành. Sao chép hướng dẫn một lần bên dưới trước khi rời trang." });
      } else {
        setIssuedChallenge(null);
        setNotice({ tone: "warning", text: "Thử thách đã tồn tại; mã tham chiếu một lần không thể hiển thị lại." });
      }
    };
    return run(action);
  }

  function changeCapability(item: Capability) {
    const nextAction = item.state === "active" ? "suspend" : "reinstate"; const idempotencyKey = crypto.randomUUID();
    const action = async () => { await api(`/api/v1/admin/creator-capabilities/${encodeURIComponent(item.userId)}`, post({ action: nextAction, reasonCode: "other", applicantExplanation: nextAction === "suspend" ? "Quyền creator tạm dừng trong khi owner rà soát." : "Quyền creator đã được khôi phục sau khi owner rà soát." }, { "idempotency-key": idempotencyKey })); setNotice({ tone: "success", text: nextAction === "suspend" ? "Đã tạm dừng quyền creator." : "Đã khôi phục quyền creator." }); await load(); };
    return run(action);
  }

  function reveal(obligation: Obligation) {
    const action = async () => { const payload = await api(`/api/v1/admin/refund-obligations/${obligation.id}/reveal`, post({})); setDestination({ obligationId: obligation.id, data: { bankName: obligation.bankName, ...(payload.destination as Record<string, unknown>) } }); };
    return run(action);
  }

  function recordRefund(event: FormEvent<HTMLFormElement>, obligation: Obligation) {
    event.preventDefault(); const values = new FormData(event.currentTarget); const outcome = values.get("outcome"); const idempotencyKey = crypto.randomUUID();
    const action = async () => { await api(`/api/v1/admin/refund-obligations/${obligation.id}/refund`, post({ outcome, ...(outcome === "sent" ? { actualAmountVnd: Number(values.get("actualAmountVnd")), outboundBankReference: values.get("outboundBankReference"), sentAt: new Date().toISOString() } : { attentionReason: values.get("attentionReason") }) }, { "idempotency-key": idempotencyKey })); setDestination(null); setNotice({ tone: "success", text: "Đã ghi nhận kết quả hoàn trả." }); await load(); };
    return run(action);
  }

  function reconcile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = new FormData(event.currentTarget); const idempotencyKey = crypto.randomUUID();
    const action = async () => { const payload = await api("/api/v1/admin/verification-deposits/reconcile", post({ bankTransactionReference: values.get("bankTransactionReference"), actualAmountVnd: Number(values.get("actualAmountVnd")), actualTransferReference: values.get("actualTransferReference"), receivedAt: new Date(String(values.get("receivedAt"))).toISOString(), sourceBankBin: values.get("sourceBankBin") || undefined, sourceAccountNumber: values.get("sourceAccountNumber") || undefined, privateNote: values.get("privateNote") }, { "idempotency-key": idempotencyKey })); setNotice(reconciliationNotice(payload)); await load(); };
    return run(action);
  }

  async function verifyStepUp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const code = new FormData(event.currentTarget).get("code"); setWorking(true);
    try { await api("/api/auth/two-factor/verify-totp", post({ code, trustDevice: false })); const retry = pendingAction.current; pendingAction.current = null; setStepUpOpen(false); if (retry) { setWorking(false); await run(retry); } }
    catch { setNotice({ tone: "error", text: "Mã TOTP chưa đúng hoặc đã hết hạn." }); }
    finally { setWorking(false); }
  }

  if (loading) return <LoadingState label="Đang tải owner workspace…" />;
  if (loadError) return <RetryState title="Chưa tải được owner workspace" onRetry={() => void load()}><p>Không có thao tác nào được thực hiện.</p></RetryState>;

  return <div className="owner-workspace">
    <div className="button-row"><Link className="button-link secondary" href="/admin/content-reports">Mở hàng đợi báo cáo nội dung</Link></div>
    <div className="owner-tabs" role="navigation" aria-label="Owner workspace">{(["queue", "refunds", "capabilities", "reconcile"] as const).map((value) => <button key={value} type="button" className={tab === value ? "secondary active" : "quiet"} aria-pressed={tab === value} onClick={() => { setTab(value); setDetail(null); setDestination(null); setIssuedChallenge(null); }}>{value === "queue" ? `Hàng đợi (${queue.length})` : value === "refunds" ? `Hoàn trả (${obligations.length})` : value === "capabilities" ? `Quyền creator (${capabilities.length})` : "Đối soát"}</button>)}</div>
    {notice ? <StatusBanner tone={notice.tone}><p>{notice.text}</p></StatusBanner> : null}
    {issuedChallenge ? <StatusBanner tone="warning" title="Hướng dẫn thử thách chỉ hiển thị một lần"><p>Mã tham chiếu: <code className="mono">{issuedChallenge.reference}</code></p><p>Chuyển đúng {issuedChallenge.amountVnd.toLocaleString("vi-VN")} VND đến {issuedChallenge.operatingAccount.bankName} · {issuedChallenge.operatingAccount.accountNumber} · {issuedChallenge.operatingAccount.accountHolderLabel}. Hết hạn {new Date(issuedChallenge.expiresAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}.</p><p>Sao chép hướng dẫn này cho creator qua kênh đã xác minh trước khi đóng hồ sơ. Pawket chỉ lưu hash và không thể hiển thị lại mã.</p></StatusBanner> : null}

    {tab === "queue" ? <div className="review-layout"><section className="work-surface stack"><div><p className="eyebrow">Hàng đợi</p><h2>Hồ sơ cần xử lý</h2></div>{queue.length === 0 ? <EmptyState title="Không có hồ sơ đang chờ" /> : <div className="queue-list">{queue.map((item) => <article key={item.id} className="queue-item"><div className="section-heading"><div><h3>{item.artistDisplayName ?? "Chưa có tên"}</h3><p className="muted">{item.primaryArtDiscipline ?? "Chưa có chuyên ngành"}</p></div><StatusTag tone={item.claimedByCurrentOwner ? "warning" : "info"}>{item.claimedByCurrentOwner ? "Claim của bạn" : "Đang chờ"}</StatusTag></div><p>{item.emailVerified ? "Email đã xác minh" : "Email chưa xác minh"} · {item.ageEligible ? "Đủ tuổi" : "Chưa đủ tuổi"} · {item.bankName ?? "Chưa có ngân hàng"} {item.maskedSuffix ?? ""}</p><button type="button" disabled={working} onClick={() => openApplication(item)}>{item.claimedByCurrentOwner ? "Tiếp tục xét duyệt" : "Claim & mở hồ sơ"}</button></article>)}</div>}</section>
      <section className="work-surface stack review-detail">{detail ? <><div className="section-heading"><div><p className="eyebrow">Chi tiết đã step-up</p><h2>{detail.revision.artistDisplayName}</h2></div><button type="button" className="quiet" onClick={() => { setDetail(null); setIssuedChallenge(null); }}>Đóng</button></div><SummaryList items={[{ label: "Email", value: detail.revision.applicantEmail }, { label: "Ngày sinh", value: detail.revision.dateOfBirth }, { label: "Chuyên ngành", value: detail.revision.primaryArtDiscipline }, { label: "Tài khoản", value: `${detail.payment.bankName ?? "—"} ${detail.payment.maskedSuffix ?? ""}` }, { label: "Xác minh", value: detail.payment.proofState }]} /><div><h3>Giới thiệu</h3><p>{detail.revision.shortIntroduction}</p><h3>Thực hành</h3><p>{detail.revision.practiceDescription}</p><h3>Portfolio</h3><ul>{detail.revision.portfolioUrls.map((url) => <li key={url}><a className="text-link" href={url} target="_blank" rel="noopener noreferrer">{url}</a></li>)}</ul></div>{!detail.payment.challengeId && detail.payment.receivingAccountVersionId ? <button type="button" className="secondary" disabled={working} onClick={issueChallenge}>Phát hành thử thách chuyển khoản</button> : null}<form className="stack" onSubmit={decide}><h3>Quyết định</h3><Field htmlFor="decision-action" label="Hành động" required><select id="decision-action" name="action" required><option value="request_changes">Yêu cầu chỉnh sửa</option><option value="approve">Phê duyệt</option><option value="reject">Từ chối</option></select></Field><Field htmlFor="reason-code" label="Lý do" required><select id="reason-code" name="reasonCode" required><option value="portfolio_insufficient">Portfolio chưa đủ</option><option value="receiving_account_unverified">Tài khoản nhận tiền chưa xác minh</option><option value="information_inconsistent">Thông tin chưa nhất quán</option><option value="eligibility_not_met">Chưa đạt điều kiện</option><option value="other">Lý do khác</option></select></Field><Field htmlFor="applicant-explanation" label="Giải thích cho creator (creator sẽ thấy)" required><textarea id="applicant-explanation" name="applicantExplanation" required /></Field><Field htmlFor="private-note" label="Ghi chú riêng (creator không thấy)"><textarea id="private-note" name="privateNote" /></Field><button disabled={working}>Xác nhận quyết định</button></form></> : <EmptyState title="Chọn một hồ sơ để xét duyệt"><p>Thông tin nhạy cảm chỉ mở sau TOTP step-up.</p></EmptyState>}</section></div> : null}

    {tab === "capabilities" ? <section className="work-surface stack"><div><p className="eyebrow">Quyền creator</p><h2>Trạng thái capability</h2></div>{capabilities.length === 0 ? <EmptyState title="Chưa có capability" /> : capabilities.map((item) => <div className="item-row" key={item.userId}><span><strong>{item.artistDisplayName ?? "Creator chưa có tên"}</strong><small className="muted mono">{item.userId}</small><small className="muted">Cập nhật {new Date(item.updatedAt).toLocaleString("vi-VN")}</small></span><div className="button-row"><StatusTag tone={item.state === "active" ? "success" : "warning"}>{item.state}</StatusTag><button type="button" className="secondary" disabled={working} onClick={() => changeCapability(item)}>{item.state === "active" ? "Tạm dừng" : "Khôi phục"}</button></div></div>)}</section> : null}

    {tab === "refunds" ? <section className="work-surface stack"><div><p className="eyebrow">Hoàn trả</p><h2>Nghĩa vụ xác minh chuyển khoản</h2></div>{obligations.length === 0 ? <EmptyState title="Không có nghĩa vụ hoàn trả" /> : obligations.map((item) => <article className="refund-item stack compact" key={item.id}><div className="section-heading"><div><h3>{item.artistDisplayName ?? "Creator chưa có tên"} · {item.amountVnd.toLocaleString("vi-VN")} VND</h3><p className="muted">{item.bankName} {item.maskedSuffix} · cửa sổ {item.refundNotBefore} → {item.refundDue}</p></div><StatusTag tone={item.state === "sent" ? "success" : item.state === "attention_required" ? "error" : "warning"}>{item.state}</StatusTag></div>{item.state !== "sent" ? <><button type="button" className="secondary" disabled={working} onClick={() => reveal(item)}>Mở đích hoàn trả bằng TOTP</button>{destination?.obligationId === item.id ? <StatusBanner tone="warning" title="Thông tin chỉ dùng cho lần hoàn này"><p className="mono">{String(destination.data.bankName ?? "")} · {String(destination.data.accountNumber ?? "")} · {String(destination.data.accountHolderLabel ?? "")}</p></StatusBanner> : null}<form className="refund-form" onSubmit={(event) => recordRefund(event, item)}><Field htmlFor={`outcome-${item.id}`} label="Kết quả" required><select id={`outcome-${item.id}`} name="outcome"><option value="sent">Đã gửi</option><option value="attention_required">Cần xử lý</option></select></Field><Field htmlFor={`amount-${item.id}`} label="Số tiền thực gửi"><input id={`amount-${item.id}`} name="actualAmountVnd" type="number" min="1" defaultValue={item.amountVnd} /></Field><Field htmlFor={`reference-${item.id}`} label="Mã giao dịch outbound"><input id={`reference-${item.id}`} name="outboundBankReference" /></Field><Field htmlFor={`attention-${item.id}`} label="Lý do cần xử lý"><input id={`attention-${item.id}`} name="attentionReason" /></Field><button disabled={working}>Ghi nhận hoàn trả</button></form></> : null}</article>)}</section> : null}

    {tab === "reconcile" ? <section className="work-surface stack"><div><p className="eyebrow">Đối soát thủ công</p><h2>Ghi nhận giao dịch đến</h2><p className="muted">Mỗi lần submit được bảo vệ bằng idempotency key và TOTP step-up.</p></div><form className="settings-columns reconcile-form" onSubmit={reconcile}><Field htmlFor="bank-reference" label="Mã giao dịch ngân hàng" required><input id="bank-reference" name="bankTransactionReference" required minLength={6} /></Field><Field htmlFor="actual-amount" label="Số tiền thực nhận" required><input id="actual-amount" name="actualAmountVnd" type="number" min="1" required /></Field><Field htmlFor="transfer-reference" label="Nội dung chuyển khoản" required><input id="transfer-reference" name="actualTransferReference" required /></Field><Field htmlFor="received-at" label="Thời điểm nhận" required><input id="received-at" name="receivedAt" type="datetime-local" required /></Field><Field htmlFor="source-bin" label="BIN ngân hàng nguồn"><input id="source-bin" name="sourceBankBin" inputMode="numeric" minLength={6} maxLength={6} /></Field><Field htmlFor="source-account" label="Số tài khoản nguồn"><input id="source-account" name="sourceAccountNumber" inputMode="numeric" /></Field><Field htmlFor="reconcile-note" label="Ghi chú riêng" required><textarea id="reconcile-note" name="privateNote" required /></Field><button disabled={working}>Đối soát giao dịch</button></form></section> : null}

    <dialog ref={dialogRef} className="step-up-dialog" onCancel={() => { pendingAction.current = null; setStepUpOpen(false); }}><form className="stack" onSubmit={verifyStepUp}><div><p className="eyebrow">Step-up bắt buộc</p><h2>Xác nhận TOTP</h2><p>Nhập mã mới nhất từ ứng dụng xác thực. Sau khi thành công, Pawket sẽ thử lại đúng thao tác vừa rồi một lần.</p></div><Field htmlFor="owner-totp" label="Mã TOTP" required><input id="owner-totp" name="code" inputMode="numeric" autoComplete="one-time-code" minLength={6} maxLength={8} autoFocus required /></Field><div className="button-row"><button disabled={working}>Xác minh &amp; thử lại</button><button type="button" className="secondary" onClick={() => { pendingAction.current = null; setStepUpOpen(false); }}>Hủy</button></div></form></dialog>
  </div>;
}
