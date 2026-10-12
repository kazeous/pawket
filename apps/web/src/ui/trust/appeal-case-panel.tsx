"use client";
import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FieldGroup } from "@/components/ui/field";
import { Field } from "../field";
import { formatTipTime, type CaseAction, type TrustCaseDetailView } from "../cases/case-client";
import { ownerText, penaltyKindLabels, penaltyTargetLabels, restrictionLabels } from "./owner-trust-client";
import { PenaltyForm } from "./penalty-form";
type Decision = Extract<CaseAction, { action: "decide_appeal" }>;
export function AppealCasePanel({ detail, disabled, onSubmit, now }: Readonly<{ detail: TrustCaseDetailView; disabled: boolean; onSubmit(action: CaseAction): void; now?: Date }>) {
  const id = useId(); const original = detail.appealAction;
  const [decision, setDecision] = useState<Decision["decision"]>("upheld"); const [kind, setKind] = useState<"restriction" | "suspension">("restriction");
  const [restriction, setRestriction] = useState<NonNullable<NonNullable<Decision["replacement"]>["restriction"]>>(original?.restriction ?? "commission_intake");
  const [target, setTarget] = useState<"account" | "creator_capability">(original?.target ?? "creator_capability"); const [error, setError] = useState<string | null>(null);
  const [penalty, setPenalty] = useState(false);
  const canReduce = !!original?.penaltyId && ["restriction", "suspension", "removal"].includes(original.kind);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (disabled || detail.state !== "open") return;
    const data = new FormData(event.currentTarget); const reasoning = ownerText(data.get("reasoning"), 4_000); let replacement: Decision["replacement"];
    if (!reasoning) { setError("Nhập kết luận 1–4.000 ký tự."); return; }
    if (decision === "reduced") {
      const rawEnd = String(data.get("endsAt") ?? ""); const end = rawEnd ? new Date(rawEnd) : null; const rank: Record<string, number> = { warning: 0, restriction: 1, suspension: 2, removal: 3 };
      const sameKind = original?.kind === kind; const scope = kind === "restriction" ? original?.kind !== "restriction" || restriction === original.restriction : target === original?.target || original?.target === "account" && target === "creator_capability";
      if (!canReduce || !original || !scope || rank[kind]! > rank[original.kind]! || end && (!Number.isFinite(end.getTime()) || end.getTime() <= (now?.getTime() ?? Date.now()))
        || sameKind && (!end || original.endsAt && end.getTime() >= Date.parse(original.endsAt))) { setError("Biện pháp thay thế phải nhẹ hơn: giữ phạm vi phù hợp và rút ngắn thời hạn, hoặc chọn mức nhẹ hơn."); return; }
      replacement = { kind, endsAt: end?.toISOString() ?? null, ...(kind === "restriction" ? { restriction } : { target }) };
    }
    setError(null); onSubmit({ action: "decide_appeal", expectedCaseVersion: detail.version, decision, reasoning, ...(replacement ? { replacement } : {}) });
  }
  const actionLabel = original?.penaltyId ? penaltyKindLabels[original.kind as keyof typeof penaltyKindLabels] : original?.hideId ? "Ẩn nội dung" : "Chưa có thông tin";
  return <section className="work-surface stack"><h2>Xem xét kháng nghị</h2><p>Biện pháp ban đầu: {actionLabel}{original?.restriction ? ` · ${restrictionLabels[original.restriction]}` : original?.target ? ` · ${penaltyTargetLabels[original.target]}` : ""}</p>
    {original?.endsAt ? <p>Kết thúc lúc <time dateTime={original.endsAt}>{formatTipTime(original.endsAt)}</time></p> : null}
    <p>Mở Nguồn kháng nghị trong Bằng chứng để xem trình bày của người kháng nghị, lý do của biện pháp ban đầu và bằng chứng liên quan.</p>
    {detail.state === "open" ? <form className="stack" onSubmit={submit}><FieldGroup>
      <Field htmlFor={`${id}-decision`} label="Quyết định" required><select id={`${id}-decision`} name="decision" disabled={disabled} value={decision} onChange={(event) => setDecision(event.target.value as typeof decision)}><option value="upheld">Giữ nguyên biện pháp</option><option value="reduced" disabled={!canReduce}>Giảm biện pháp</option><option value="reversed">Hủy biện pháp</option></select></Field>
      {decision === "reduced" ? <>
        <Field htmlFor={`${id}-kind`} label="Biện pháp thay thế" required><select id={`${id}-kind`} name="replacementKind" value={kind} disabled={disabled} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="restriction">Hạn chế</option><option value="suspension" disabled={original?.kind === "restriction"}>Tạm khóa</option></select></Field>
        {kind === "restriction" ? <Field htmlFor={`${id}-restriction`} label="Thao tác bị hạn chế" required><select id={`${id}-restriction`} name="restriction" value={restriction} disabled={disabled} onChange={(event) => setRestriction(event.target.value as typeof restriction)}>{Object.entries(restrictionLabels).map(([value, label]) => <option key={value} value={value} disabled={original?.kind === "restriction" && original.restriction !== value}>{label}</option>)}</select></Field> : <Field htmlFor={`${id}-target`} label="Phạm vi" required><select id={`${id}-target`} name="target" value={target} disabled={disabled} onChange={(event) => setTarget(event.target.value as typeof target)}>{Object.entries(penaltyTargetLabels).map(([value, label]) => <option key={value} value={value} disabled={original?.target === "creator_capability" && value === "account"}>{label}</option>)}</select></Field>}
        <Field htmlFor={`${id}-end`} label="Kết thúc lúc" hint="Cùng mức biện pháp phải có thời hạn ngắn hơn; giờ trên thiết bị của bạn."><Input id={`${id}-end`} name="endsAt" type="datetime-local" disabled={disabled} /></Field>
      </> : null}
      <Field htmlFor={`${id}-reasoning`} label="Kết luận (người kháng nghị sẽ thấy)" required hint="1–4.000 ký tự. Không nêu tên, vai trò hoặc nội dung báo cáo của người báo cáo." error={error}><Textarea id={`${id}-reasoning`} name="reasoning" required disabled={disabled} /></Field>
    </FieldGroup>{decision === "reversed" ? <p>Biện pháp ban đầu sẽ được hủy. Các đơn đã đóng do đóng băng không thể khôi phục.</p> : null}{error ? <p role="alert">{error}</p> : null}<Button type="submit" disabled={disabled}>Ghi nhận quyết định</Button></form> : null}
    <Button variant="outline" disabled={disabled || detail.parties.length === 0} onClick={() => setPenalty(!penalty)}>Áp dụng biện pháp</Button>
    {penalty ? <PenaltyForm parties={detail.parties} disabled={disabled} onSubmit={onSubmit} now={now} /> : null}
  </section>;
}
