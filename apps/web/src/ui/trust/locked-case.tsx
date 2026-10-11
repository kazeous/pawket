"use client";
import { useState } from "react";
import type { HelpCaseView } from "@pawket/trust";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SummaryList } from "@/ui/summary-list";
import { StatusBanner } from "@/ui/status-banner";
import { formatTipTime } from "../tips/tip-client";
import { AppealForm } from "./appeal-form";
import { appealStateLabels, penaltyKindLabels, penaltyStateLabels } from "./trust-client";

export function LockedCase({ view }: Readonly<{ view: HelpCaseView }>) {
  const [sent, setSent] = useState(false);
  return <><Card><CardHeader><CardTitle role="heading" aria-level={2}>{penaltyKindLabels[view.kind]}</CardTitle><CardDescription>{penaltyStateLabels[view.state]}</CardDescription></CardHeader>
    <CardContent className="flex flex-col gap-4"><p className="whitespace-pre-wrap wrap-anywhere">{view.explanation}</p><SummaryList items={[
      { label: "Bắt đầu", value: formatTipTime(view.startsAt) }, { label: "Hết hạn", value: view.endsAt ? formatTipTime(view.endsAt) : "Không có thời hạn" },
    ]} />{view.enforcementPolicyRevisionId ? <a className="underline" href={`/help/policies/${view.enforcementPolicyRevisionId}`}>Chính sách áp dụng cho biện pháp này</a> : <p>Chưa được công bố</p>}
    {sent ? <StatusBanner tone="success">Đã gửi kháng nghị. Pawket đang xem xét.</StatusBanner> : view.appeal ? <div className="flex flex-col gap-3"><p>Kháng nghị · {appealStateLabels[view.appeal.state]}</p>
      {view.appeal.state !== "open" && view.appeal.reasoning ? <p className="whitespace-pre-wrap wrap-anywhere">{view.appeal.reasoning}</p> : null}
      {view.appeal.decidedAt ? <p>Kết luận ngày {formatTipTime(view.appeal.decidedAt)}</p> : null}</div>
      : view.canAppeal ? <AppealForm target={{ penaltyId: view.penaltyId }} helpSession onSubmitted={() => setSent(true)} /> : <p>Không còn quyền gửi kháng nghị cho biện pháp này.</p>}
    <p className="text-sm text-muted-foreground">Có thể xem thông báo đến {formatTipTime(view.readOnlyUntil)}.</p></CardContent>
  </Card><form action="/help/locked/end" method="post"><Button type="submit" variant="outline">Kết thúc phiên</Button></form></>;
}
