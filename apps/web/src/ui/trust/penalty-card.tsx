"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SummaryList } from "@/ui/summary-list";
import { StatusBanner } from "@/ui/status-banner";
import { formatTipTime } from "../tips/tip-client";
import { useResolutionDeadline } from "../resolutions/resolution-deadline";
import { AppealForm } from "./appeal-form";
import { appealStateLabels, penaltyKindLabels, penaltyStateLabels, penaltyTargetLabels, restrictionLabels, targetKindLabels, type AppealTarget, type HideView, type PenaltyView } from "./trust-client";

function AppealAction({ row, target }: Readonly<{ row: Pick<PenaltyView, "canAppeal" | "appealDeadline" | "appealState">; target: AppealTarget }>) {
  const [open, setOpen] = useState(false); const [sent, setSent] = useState(false);
  const [openedAt] = useState(() => Date.now());
  const expired = useResolutionDeadline(row.appealDeadline) || !!row.appealDeadline && openedAt >= Date.parse(row.appealDeadline);
  if (sent) return <StatusBanner tone="success">Đã gửi kháng nghị. Pawket đang xem xét.</StatusBanner>;
  if (row.appealState) return <p>Kháng nghị · {appealStateLabels[row.appealState]}</p>;
  if (!row.canAppeal || !row.appealDeadline || expired) return null;
  return <div className="flex flex-col items-start gap-3">
    <p className="text-sm">Kháng nghị trước {formatTipTime(row.appealDeadline!)}</p><Button variant="outline" aria-expanded={open} onClick={() => setOpen(!open)}>Kháng nghị</Button>
    {open ? <AppealForm target={target} onSubmitted={() => setSent(true)} /> : null}
  </div>;
}
export function PenaltyCard({ penalty }: Readonly<{ penalty: PenaltyView }>) {
  return <Card><CardHeader><CardTitle role="heading" aria-level={2}>{penaltyKindLabels[penalty.kind]}</CardTitle><CardDescription>{penaltyStateLabels[penalty.state]}</CardDescription></CardHeader>
    <CardContent className="flex flex-col gap-3"><p className="whitespace-pre-wrap wrap-anywhere">{penalty.explanation}</p><SummaryList items={[
      { label: "Lý do", value: penalty.reasonCategoryLabel }, ...(penalty.restriction ? [{ label: "Hạn chế", value: restrictionLabels[penalty.restriction] }] : []),
      ...(penalty.target ? [{ label: "Phạm vi", value: penaltyTargetLabels[penalty.target] }] : []), { label: "Bắt đầu", value: formatTipTime(penalty.startsAt) },
      ...(penalty.endsAt ? [{ label: "Hết hạn", value: formatTipTime(penalty.endsAt) }] : []), ...(penalty.endedAt ? [{ label: "Kết thúc", value: formatTipTime(penalty.endedAt) }] : []),
    ]} /><AppealAction row={penalty} target={{ penaltyId: penalty.penaltyId }} /></CardContent></Card>;
}
export function HideCard({ hide }: Readonly<{ hide: HideView }>) {
  return <Card><CardHeader><CardTitle role="heading" aria-level={2}>{targetKindLabels[hide.targetKind]} · {hide.releasedAt ? "Đã khôi phục" : "Đã bị ẩn"}</CardTitle></CardHeader>
    <CardContent className="flex flex-col gap-3"><p>{hide.explanation}</p><SummaryList items={[{ label: "Ngày ẩn", value: formatTipTime(hide.hiddenAt) }]} /><AppealAction row={hide} target={{ hideId: hide.hideId }} /></CardContent></Card>;
}
