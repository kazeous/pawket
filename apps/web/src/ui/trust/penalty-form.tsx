"use client";
import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FieldGroup } from "@/components/ui/field";
import { Field } from "../field";
import type { CaseAction, SourceParty } from "../cases/case-client";
import { ownerText, penaltyEffect, penaltyKindLabels, penaltyReasonLabels, penaltyTargetLabels, restrictionLabels } from "./owner-trust-client";
type Penalty = Extract<CaseAction, { action: "penalty" }>;
export function PenaltyForm({ parties, disabled, onSubmit, now }: Readonly<{ parties: readonly SourceParty[]; disabled: boolean; onSubmit(action: Penalty): void; now?: Date }>) {
  const id = useId(); const [kind, setKind] = useState<Penalty["kind"]>("warning"); const [target, setTarget] = useState<"creator_capability" | "account">("creator_capability");
  const [restriction, setRestriction] = useState<NonNullable<Penalty["restriction"]>>("commission_intake"); const [error, setError] = useState<string | null>(null);
  const blocked = disabled || parties.length === 0;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (blocked) return;
    const data = new FormData(event.currentTarget); const subjectUserId = String(data.get("subjectUserId")); const explanation = ownerText(data.get("explanation"), 2_000);
    const rawNote = String(data.get("internalNote") ?? "").trim(); const internalNote = rawNote ? ownerText(rawNote, 2_000) : undefined;
    const rawEnd = String(data.get("endsAt") ?? ""); const end = rawEnd ? new Date(rawEnd) : null; const at = now?.getTime() ?? Date.now(); const reasonCategory = String(data.get("reasonCategory"));
    if (!parties.some((party) => party.userId === subjectUserId) || !explanation || internalNote === null || !Object.hasOwn(penaltyReasonLabels, reasonCategory)
      || end && (!Number.isFinite(end.getTime()) || end.getTime() <= at || end.getTime() > at + 3_650 * 86_400_000)) { setError("Kiểm tra người dùng, lý do 1–2.000 ký tự và thời hạn trong tương lai (tối đa 10 năm)."); return; }
    setError(null); onSubmit({ action: "penalty", subjectUserId, kind, reasonCategory, explanation, ...(internalNote ? { internalNote } : {}),
      ...(kind === "restriction" ? { restriction, endsAt: end?.toISOString() ?? null } : kind === "suspension" ? { target, endsAt: end?.toISOString() ?? null,
        ...(target === "creator_capability" ? { freezeFulfilment: data.get("freezeFulfilment") === "on" } : {}) } : kind === "removal" ? { target } : {}) });
  }
  return <form className="stack" onSubmit={submit}><h3>Áp dụng biện pháp</h3><FieldGroup>
    <Field htmlFor={`${id}-subject`} label="Người dùng" required><select id={`${id}-subject`} name="subjectUserId" disabled={blocked}>{parties.map((party) => <option key={party.userId} value={party.userId}>{party.label} · {party.userId}</option>)}</select></Field>
    <Field htmlFor={`${id}-kind`} label="Biện pháp" required><select id={`${id}-kind`} name="kind" value={kind} disabled={blocked} onChange={(event) => { setKind(event.target.value as Penalty["kind"]); setError(null); }}>{Object.entries(penaltyKindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
    {kind === "restriction" ? <Field htmlFor={`${id}-restriction`} label="Thao tác bị hạn chế" required><select id={`${id}-restriction`} name="restriction" disabled={blocked} value={restriction} onChange={(event) => setRestriction(event.target.value as typeof restriction)}>{Object.entries(restrictionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field> : null}
    {kind === "suspension" || kind === "removal" ? <Field htmlFor={`${id}-target`} label="Phạm vi" required><select id={`${id}-target`} name="target" disabled={blocked} value={target} onChange={(event) => setTarget(event.target.value as typeof target)}>{Object.entries(penaltyTargetLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field> : null}
    {kind === "restriction" || kind === "suspension" ? <Field htmlFor={`${id}-end`} label="Kết thúc lúc" hint="Để trống nếu không có ngày kết thúc; giờ trên thiết bị của bạn."><Input id={`${id}-end`} name="endsAt" type="datetime-local" disabled={blocked} /></Field> : null}
    {kind === "suspension" && target === "creator_capability" ? <Field htmlFor={`${id}-freeze`} label="Đóng băng thực hiện đơn"><input id={`${id}-freeze`} name="freezeFulfilment" type="checkbox" disabled={blocked} /></Field> : null}
    <Field htmlFor={`${id}-category`} label="Nhóm lý do" required><select id={`${id}-category`} name="reasonCategory" disabled={blocked}>{Object.entries(penaltyReasonLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
    <Field htmlFor={`${id}-explanation`} label="Giải thích (người dùng sẽ thấy)" required error={error} hint="1–2.000 ký tự."><Textarea id={`${id}-explanation`} name="explanation" required disabled={blocked} /></Field>
    <Field htmlFor={`${id}-note`} label="Ghi chú nội bộ (chỉ owner thấy)" hint="Tối đa 2.000 ký tự."><Textarea id={`${id}-note`} name="internalNote" disabled={blocked} /></Field>
  </FieldGroup><p role="status">{penaltyEffect(kind, target, restriction)}</p>{kind === "suspension" && target === "creator_capability" ? <p>Nếu chọn đóng băng, mọi đơn đã thanh toán đang thực hiện sẽ đóng và phát sinh hoàn tiền toàn bộ; không thể khôi phục các đơn này.</p> : null}
    {parties.length === 0 ? <p>Không có người dùng đủ điều kiện trong nguồn này.</p> : null}{error ? <p role="alert">{error}</p> : null}<Button type="submit" disabled={blocked}>Áp dụng biện pháp</Button></form>;
}
