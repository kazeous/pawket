"use client";
import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldGroup } from "@/components/ui/field";
import { Field } from "../field";
import type { CaseAction, TrustCaseDetailView } from "../cases/case-client";
import { PenaltyForm } from "./penalty-form";
import { ownerText } from "./owner-trust-client";
const targetLabels: Record<string, string> = { commission_brief: "Yêu cầu sáng tác", commission_message: "Tin nhắn", commission_file: "Tệp", commission_package: "Gói commission" };
export function ReportCasePanel({ detail, disabled, onSubmit }: Readonly<{ detail: TrustCaseDetailView; disabled: boolean; onSubmit(action: CaseAction): void }>) {
  const id = useId(); const [penalty, setPenalty] = useState(false); const [error, setError] = useState<string | null>(null);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (disabled || detail.state !== "open") return;
    const data = new FormData(event.currentTarget); const reason = ownerText(data.get("reason"), 2_000, false); const operation = String(data.get("operation"));
    if (!reason) { setError("Nhập lý do 1–2.000 ký tự, không xuống dòng."); return; } setError(null);
    const base = { expectedCaseVersion: detail.version, reason };
    if (operation === "close_report") onSubmit({ action: "close_report", ...base, resolution: data.get("resolution") === "actioned" ? "actioned" : "dismissed" });
    else if (operation === "restore" && detail.activeHideId) onSubmit({ action: "restore", ...base, hideId: detail.activeHideId });
    else if (operation === "hide" && detail.sourceType !== "commission_brief") onSubmit({ action: "hide", ...base });
  }
  const canHide = detail.sourceType !== "commission_brief";
  return <section className="work-surface stack"><h2>Nội dung được báo cáo</h2><p>{targetLabels[detail.sourceType] ?? "Nội dung"} · <span className="mono break-all">{detail.sourceId}</span></p>
    <p>Danh sách báo cáo, lý do, thời điểm và danh tính người báo cáo chỉ owner thấy khi mở Ngữ cảnh báo cáo trong Bằng chứng.</p>
    {detail.state === "open" ? <form className="stack" onSubmit={submit}><FieldGroup>
      <Field htmlFor={`${id}-action`} label="Hành động" required><select id={`${id}-action`} name="operation" disabled={disabled}>{canHide ? detail.activeHideId ? <option value="restore">Khôi phục mục tiêu</option> : <option value="hide">Ẩn mục tiêu</option> : null}<option value="close_report">Đóng báo cáo</option></select></Field>
      <Field htmlFor={`${id}-resolution`} label="Kết quả đóng báo cáo"><select id={`${id}-resolution`} name="resolution" disabled={disabled}><option value="dismissed">Bỏ qua (không áp dụng biện pháp)</option><option value="actioned">Đã xử lý (đã ẩn hoặc áp dụng biện pháp)</option></select></Field>
      <Field htmlFor={`${id}-reason`} label="Lý do" required error={error}><Input id={`${id}-reason`} name="reason" required disabled={disabled} /></Field>
    </FieldGroup>{error ? <p role="alert">{error}</p> : null}<Button type="submit" disabled={disabled}>Xác nhận xử lý báo cáo</Button></form> : null}
    <Button variant="outline" disabled={disabled} onClick={() => setPenalty(!penalty)}>Áp dụng biện pháp</Button>
    {penalty ? <PenaltyForm parties={detail.parties} disabled={disabled} onSubmit={onSubmit} /> : null}
  </section>;
}
