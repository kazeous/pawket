"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { StatusBanner } from "@/ui/status-banner";
import { TrustCommandFeedback, useTrustCommand } from "./trust-command";
import { parseCommission } from "../commissions/commission-client";
import { acknowledgeResultSchema, type PenaltyView, type TrustMode } from "./trust-client";

export function EnforcementBanner({ penalties, mode, actorUserId }: Readonly<{ penalties: readonly PenaltyView[]; mode: TrustMode; actorUserId?: string | undefined }>) {
  const command = useTrustCommand(actorUserId); const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(new Set());
  if (mode !== "enabled") return null;
  const warnings = penalties.filter((row) => row.kind === "warning" && row.acknowledgedAt === null && !acknowledged.has(row.penaltyId));
  if (!warnings.length) return null;
  return <div className="flex flex-col gap-3"><TrustCommandFeedback command={command} />{warnings.map((warning) => <StatusBanner key={warning.penaltyId} tone="warning" title="Tài khoản của bạn đã nhận một cảnh cáo.">
    <div className="flex flex-col items-start gap-3"><p className="whitespace-pre-wrap wrap-anywhere">{warning.explanation}</p><a href="/help/cases" className="underline">Xem Yêu cầu của tôi</a>
      <Button variant="outline" disabled={command.locked} onClick={() => command.execute(`/api/v1/help/warnings/${warning.penaltyId}/acknowledge`, {}, (value) => {
        parseCommission(acknowledgeResultSchema, value); setAcknowledged((current) => new Set([...current, warning.penaltyId]));
      })}>Tôi đã hiểu</Button></div>
  </StatusBanner>)}</div>;
}
