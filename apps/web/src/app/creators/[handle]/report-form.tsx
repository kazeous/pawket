"use client";

import { type FormEvent, useRef, useState } from "react";

import { Field } from "../../../ui/field";
import { FormErrorSummary, type FieldError } from "../../../ui/form-error-summary";
import { solveReportChallenge } from "./report-proof";

type Target = Readonly<{ targetType: "page" | "showcase"; targetId: string; publicationRevisionId: string }>;

export function ReportForm({ target, label }: Readonly<{ target: Target; label: string }>) {
  const [open, setOpen] = useState(false); const [working, setWorking] = useState(false); const [progress, setProgress] = useState(0); const [accepted, setAccepted] = useState(false); const [errors, setErrors] = useState<readonly FieldError[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setWorking(true); setErrors([]); setProgress(0);
    const values = new FormData(event.currentTarget); const body = { target, reason: values.get("reason"), ...(values.get("detail") ? { detail: values.get("detail") } : {}) };
    const controller = new AbortController(); abortRef.current = controller;
    try {
      let response = await fetch("/api/v1/content-reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
      if (response.status === 400 || response.status === 401) {
        const challengeResponse = await fetch("/api/v1/content-reports/challenge", { cache: "no-store", signal: controller.signal });
        if (!challengeResponse.ok) throw new Error("REPORT_NOT_ACCEPTED");
        const challenge = await challengeResponse.json() as { token: string; difficulty: number };
        const solution = await solveReportChallenge(challenge, controller.signal, setProgress);
        response = await fetch("/api/v1/content-reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, challenge: { token: challenge.token, solution } }), signal: controller.signal });
      }
      if (!response.ok) throw new Error("REPORT_NOT_ACCEPTED");
      setAccepted(true);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) setErrors([{ fieldId: `report-${target.targetId}`, message: "Chưa thể gửi báo cáo. Hãy thử lại sau." }]);
    } finally { abortRef.current = null; setWorking(false); }
  }

  if (accepted) return <p role="status">Đã nhận báo cáo. Báo cáo không tự động ẩn nội dung; owner sẽ xem xét theo cùng một quy trình.</p>;
  return <div id={`report-${target.targetId}`} className="report-form"><button type="button" className="quiet" aria-expanded={open} onClick={() => setOpen(!open)}>{label}</button>{open ? <form className="stack" onSubmit={submit}><FormErrorSummary errors={errors} title="Báo cáo chưa được gửi" /><Field htmlFor={`report-reason-${target.targetId}`} label="Lý do báo cáo" required><select id={`report-reason-${target.targetId}`} name="reason" required><option value="privacy">Quyền riêng tư</option><option value="intellectual_property">Quyền sở hữu trí tuệ</option><option value="impersonation">Mạo danh</option><option value="spam_or_scam">Spam hoặc lừa đảo</option><option value="harassment_or_hate">Quấy rối hoặc thù ghét</option><option value="violence_or_self_harm">Bạo lực hoặc tự gây hại</option><option value="prohibited_or_age_restricted_content">Nội dung bị cấm</option><option value="other">Lý do khác</option></select></Field><Field htmlFor={`report-detail-${target.targetId}`} label="Chi tiết" hint="Không nhập thông tin cá nhân của bạn; tối đa 1.000 ký tự."><textarea id={`report-detail-${target.targetId}`} name="detail" maxLength={1000} /></Field><div className="button-row"><button disabled={working}>{working ? "Đang chuẩn bị bằng chứng…" : "Gửi báo cáo"}</button>{working ? <button type="button" className="secondary" onClick={() => abortRef.current?.abort()}>Hủy tạo bằng chứng</button> : null}</div><p role="status" aria-live="polite">{working ? `Đã thử ${progress.toLocaleString("vi-VN")} mã. Bạn có thể hủy bất cứ lúc nào.` : ""}</p></form> : null}</div>;
}
