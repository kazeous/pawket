"use client";

import { useId, useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { formatTipTime } from "@/ui/tips/tip-client";
import { commissionPath, orderResultSchema, parseCommission, type OrderView, type SubmissionView } from "./commission-client";
import { CommandFeedback, useCommissionCommand } from "./commission-session";
import { AttachedFileList } from "./reference-files";

export function SubmissionCard({ submission, order, disabled, onUpdated }: Readonly<{
  submission: SubmissionView; order: OrderView["order"]; disabled: boolean; onUpdated(): void;
}>) {
  const id = useId(); const command = useCommissionCommand(); const [changes, setChanges] = useState(false); const [note, setNote] = useState("");
  const remaining = Math.max(0, (order.fulfillment?.revisionAllowance ?? 0) - (order.fulfillment?.revisionsUsed ?? 0));
  const changeLabel = `Yêu cầu chỉnh sửa (còn ${remaining} lượt)`;
  const locked = disabled || command.locked;
  const actionable = submission.actionable && order.role === "buyer" &&
    (submission.submissionKind === "draft" ? order.state === "in_progress" : order.state === "delivered");
  function respond(response: "approve" | "request_changes" | "accept") {
    if (locked || !actionable) return;
    command.execute(`/api/v1${commissionPath(order.role)}/${order.id}/submissions/${submission.id}/respond`,
      { expectedVersion: order.version, response, ...(response === "request_changes" ? { note } : {}) }, (value) => {
        if (parseCommission(orderResultSchema, value).orderId !== order.id) throw new Error("Invalid commission result");
        setChanges(false); setNote(""); onUpdated();
      });
  }
  const noteLength = [...note.normalize("NFC").trim()].length;
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (noteLength >= 1 && noteLength <= 2000 && remaining > 0) respond("request_changes"); }
  return <Card className="min-w-0" data-submission-card>
    <CardHeader><CardTitle role="heading" aria-level={3}><Badge variant="secondary">{submission.submissionKind === "draft" ? "Bản nháp" : "Bản giao cuối"}</Badge></CardTitle>
      <CardDescription><time dateTime={submission.submittedAt}>{formatTipTime(submission.submittedAt)}</time>{submission.late ? <Badge variant="outline">Giao trễ hạn</Badge> : null}</CardDescription></CardHeader>
    <CardContent className="flex min-w-0 flex-col gap-4">
      {submission.note ? <p className="whitespace-pre-wrap wrap-anywhere">{submission.note}</p> : null}
      <AttachedFileList order={order} files={submission.files} />
      {submission.respondedAt ? <div className="flex flex-col gap-2 text-sm"><time dateTime={submission.respondedAt}>{formatTipTime(submission.respondedAt)}</time>
        {submission.response === "approved" ? <p>Duyệt và tiếp tục</p> : null}
        {submission.responseNote ? <p className="whitespace-pre-wrap wrap-anywhere">{submission.responseNote}</p> : null}</div> : null}
      <CommandFeedback command={command} />
      {actionable ? <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2"><Button disabled={locked} onClick={() => respond(submission.submissionKind === "draft" ? "approve" : "accept")}>{submission.submissionKind === "draft" ? "Duyệt và tiếp tục" : "Chấp nhận"}</Button>
          {remaining > 0 ? <Button variant="outline" disabled={locked} onClick={() => setChanges(true)}>{changeLabel}</Button> : null}</div>
        {remaining === 0 ? <p className="text-sm text-muted-foreground">Đã dùng hết lượt chỉnh sửa. Bạn vẫn có thể nhắn cho nghệ sĩ.</p> : null}
        {changes && remaining > 0 ? <form aria-label={changeLabel} onSubmit={submit}><FieldGroup>
          <Field data-disabled={locked || undefined}><FieldLabel htmlFor={`${id}-changes`}>{changeLabel}</FieldLabel><Textarea id={`${id}-changes`} value={note} onChange={(event) => setNote(event.target.value)} required maxLength={4000} disabled={locked} /></Field>
          <Button type="submit" className="self-start" disabled={locked || noteLength < 1 || noteLength > 2000}>Gửi</Button>
        </FieldGroup></form> : null}
      </div> : null}
    </CardContent>
  </Card>;
}
