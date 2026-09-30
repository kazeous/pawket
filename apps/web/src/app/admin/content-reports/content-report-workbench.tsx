"use client";

import { useCallback, useEffect, useState } from "react";

import { StatusBanner } from "../../../ui/status-banner";
import { redirectToOidcReview } from "../../../auth/oidc-review-redirect";

type Report = Readonly<{ reportId: string; target: Readonly<{ targetType: "page" | "showcase"; targetId: string; publicationRevisionId: string }>; reason: string; detail: string | null; state: "open" | "dismissed" | "held" | "closed"; version: number; snapshot: Readonly<{ target: Readonly<{ targetType: string; targetId: string; publicationRevisionId: string }>; pageId: string; canonicalHandle: string; displayName: string; showcaseTitle: string | null }>; activeHold: null | Readonly<{ holdId: string; targetType: string }>; priorActions: readonly Readonly<{ action: string; reason: string; beforeState: string; afterState: string; resultingReportVersion: number; occurredAt: string | Date }>[] }>;

class TriageError extends Error { constructor(readonly code: string) { super(code); } }
async function payload(response: Response) { try { const value = await response.json() as Record<string, unknown>; if (!response.ok) redirectToOidcReview(value); return value; } catch { return {}; } }

export function ContentReportWorkbench({ initialActorUserId }: { initialActorUserId: string }) {
  const [reports, setReports] = useState<readonly Report[]>([]); const [loading, setLoading] = useState(true); const [working, setWorking] = useState(false); const [notice, setNotice] = useState<{ tone: "success" | "error" | "warning"; text: string } | null>(null);
  const load = useCallback(async () => { setLoading(true); try { const response = await fetch("/api/v1/admin/content-reports", { cache: "no-store" }); if (!response.ok) throw new Error(); const result = await payload(response); setReports(Array.isArray(result.reports) ? result.reports as Report[] : []); } catch { setNotice({ tone: "error", text: "Chưa tải được hàng đợi báo cáo." }); } finally { setLoading(false); } }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  async function run(action: () => Promise<void>) { setWorking(true); setNotice(null); try { await action(); } catch (error) { setNotice({ tone: error instanceof TriageError && (error.code === "VERSION_CONFLICT" || error.code === "INVALID_STATE") ? "warning" : "error", text: error instanceof TriageError && error.code === "VERSION_CONFLICT" ? "Báo cáo đã thay đổi. Pawket đã tải phiên bản hiện tại; không có hành động cũ nào được áp dụng." : "Chưa thể xử lý báo cáo." }); await load(); } finally { setWorking(false); } }
  function triage(report: Report, action: "dismiss" | "hide" | "restore") {
    const idempotencyKey = crypto.randomUUID();
    const execute = async () => { const response = await fetch(`/api/v1/admin/content-reports/${report.reportId}`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey, "If-Match": String(report.version), "x-pawket-actor": initialActorUserId }, body: JSON.stringify({ action, reason: action === "dismiss" ? "Owner xác nhận không cần ẩn nội dung." : action === "hide" ? "Owner tạm ẩn trong khi xử lý báo cáo." : "Owner hoàn tất rà soát và khôi phục nội dung.", ...(action === "restore" ? { holdId: report.activeHold?.holdId } : {}) }) }); if (!response.ok) { const problem = await payload(response); throw new TriageError(typeof problem.code === "string" ? problem.code : "TRIAGE_UNAVAILABLE"); } setNotice({ tone: "success", text: action === "hide" ? "Đã ẩn mục tiêu và ghi audit event." : action === "restore" ? "Đã khôi phục mục tiêu và ghi audit event." : "Đã đóng báo cáo và ghi audit event." }); await load(); };
    return run(execute);
  }

  if (loading) return <p role="status">Đang tải hàng đợi báo cáo…</p>;
  return <div className="content-report-workbench stack">{notice ? <StatusBanner tone={notice.tone}><p>{notice.text}</p></StatusBanner> : null}{reports.length === 0 ? <section className="work-surface"><h2>Không có báo cáo cần xử lý</h2></section> : <div className="triage-layout">{reports.map((report) => <article className="work-surface stack" key={report.reportId}><div><p className="eyebrow">{report.state} · phiên bản {report.version}</p><h2>{report.snapshot.displayName}</h2><p className="muted">@{report.snapshot.canonicalHandle}{report.snapshot.showcaseTitle ? ` · ${report.snapshot.showcaseTitle}` : ""}</p></div><dl className="summary-list"><div><dt>Lý do</dt><dd>{report.reason}</dd></div><div><dt>Chi tiết</dt><dd>{report.detail || "Không có"}</dd></div><div><dt>Mục tiêu</dt><dd>{report.target.targetType} · revision {report.target.publicationRevisionId}</dd></div></dl><div className="button-row">{report.state === "open" ? <><button type="button" className="secondary" disabled={working} onClick={() => void triage(report, "dismiss")}>Bỏ qua báo cáo</button><button type="button" disabled={working} onClick={() => void triage(report, "hide")}>Ẩn mục tiêu</button></> : null}{report.state === "held" && report.activeHold ? <button type="button" disabled={working} onClick={() => void triage(report, "restore")}>Khôi phục mục tiêu</button> : null}</div>{report.priorActions.length > 0 ? <details><summary>Lịch sử audit</summary><ul>{report.priorActions.map((item) => <li key={`${item.action}-${item.resultingReportVersion}`}>{item.action}: {item.beforeState} → {item.afterState} · {item.reason}</li>)}</ul></details> : null}</article>)}</div>}
  </div>;
}
