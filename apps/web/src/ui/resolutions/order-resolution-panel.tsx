"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionBar } from "@/ui/action-bar";
import { StatusBanner } from "@/ui/status-banner";
import { SummaryList } from "@/ui/summary-list";
import { formatTipTime, formatVnd } from "@/ui/tips/tip-client";
import { commissionPath, commissionRead, parseCommission, type OrderView } from "../commissions/commission-client";
import { CommandFeedback, useCommissionCommand, useCommissionSession } from "../commissions/commission-session";
import { DisputeForm, DisputePanel } from "./dispute-panel";
import { LateClaimPanel } from "./late-claim-panel";
import { ProposalForm } from "./proposal-form";
import { RefundPanel } from "./refund-panel";
import { disputeBefore, proposalStateLabels, resolutionPath, resolutionRequest, resolutionSchema, type ResolutionAction, type ResolutionView } from "./resolution-client";
import { useResolutionDeadline } from "./resolution-deadline";

export function OrderResolutionPanel({ order, initial = null, banks = {}, disabled = false, onRefresh }: Readonly<{ order: OrderView["order"]; initial?: ResolutionView | null;
  banks?: Readonly<Record<string, string>>; disabled?: boolean; onRefresh(): Promise<void> }>) {
  const [view, setView] = useState(initial); const [failed, setFailed] = useState(false); const [busy, setBusy] = useState(false);
  const [proposing, setProposing] = useState(false); const [disputing, setDisputing] = useState(false); const [cancelling, setCancelling] = useState(false); const [accepting, setAccepting] = useState(false);
  const command = useCommissionCommand(resolutionRequest); const verify = useCommissionSession(); const running = useRef(false); const alive = useRef(true);
  const base = `/api/v1${commissionPath(order.role)}/${order.id}`;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const reload = useCallback(async () => {
    if (running.current) return; running.current = true; setBusy(true);
    try {
      await verify(); const next = await commissionRead(`${base}/resolution`, resolutionSchema, 2_097_152); await verify();
      if (next.resolution.role !== order.role) throw new Error("Invalid resolution role");
      if (alive.current) { setView(next); setFailed(false); setProposing(false); setDisputing(false); setCancelling(false); setAccepting(false); }
    } catch { if (alive.current) setFailed(true); } finally { running.current = false; if (alive.current) setBusy(false); }
  }, [base, order.role, verify]);
  useEffect(() => { const timer = setTimeout(() => void reload(), 0); return () => clearTimeout(timer); }, [reload, order.version]);
  const refresh = useCallback(async () => { await onRefresh(); await reload(); }, [onRefresh, reload]);
  useEffect(() => { if (command.code && !command.locked) { const timer = setTimeout(() => void refresh(), 0); return () => clearTimeout(timer); } }, [command.code, command.locked, refresh]);
  function mutate(action: ResolutionAction, payload: object, targetId?: string) {
    command.execute(resolutionPath(order.role, order.id, action, targetId), payload, (value) => {
      // Commands intentionally return only their result reference or version.
      parseCommission(z.union([z.object({ proposalId: z.uuid() }), z.object({ disputeId: z.uuid() }), z.object({ statementId: z.uuid() }), z.object({ obligationId: z.uuid() }), z.object({ version: z.number().int().positive() })]), value);
      void refresh();
    });
  }
  const r = view?.resolution; const enabled = view?.controls.mode === "enabled"; const locked = disabled || !enabled || command.locked || busy || failed;
  const pending = r?.proposals.pending; const pendingExpired = useResolutionDeadline(pending?.respondBy);
  const disputeExpired = useResolutionDeadline(r?.actions.disputeTriggerEndsAt ? disputeBefore(r.actions.disputeTrigger, r.actions.disputeTriggerEndsAt) : null);
  const lateEligible = order.state === "closed" && !order.confirmedAt && !!order.payment && ["expired", "rejected"].includes(order.payment.state)
    && ["payment_expired", "buyer_cancelled", "creator_cancelled", "security_invalidated", "eligibility_invalidated"].includes(order.closeReason ?? "");
  return <Card data-resolution-panel className="min-w-0"><CardHeader><CardTitle role="heading" aria-level={2}>Gặp vấn đề với đơn?</CardTitle><CardDescription>Hủy đơn, khiếu nại và theo dõi hoàn tiền. Pawket không tự chuyển tiền.</CardDescription></CardHeader><CardContent className="flex min-w-0 flex-col gap-5">
    <CommandFeedback command={command} />
    {order.state === "closed" && !!order.confirmedAt && order.role === "buyer" ? <StatusBanner>Đơn đã hủy nên bạn không còn tải được tệp của nghệ sĩ. Pawket không thể thu hồi các bản bạn đã tải về.</StatusBanner> : null}
    {!r ? <StatusBanner>{failed ? "Chưa tải được thông tin xử lý đơn." : "Đang tải thông tin xử lý đơn…"}</StatusBanner> : null}
    {failed ? <Button variant="outline" onClick={() => void refresh()}>Cập nhật thông tin xử lý đơn</Button> : null}
    {r && !enabled ? <StatusBanner>Tạm dừng xử lý hủy đơn, khiếu nại và hoàn tiền. Bạn vẫn xem được lịch sử.</StatusBanner> : null}
    {r?.actions.canPropose ? <><Button variant="outline" className="self-start" disabled={locked} onClick={() => setProposing(true)}>Đề nghị hủy hoặc hoàn tiền</Button>{proposing ? <ProposalForm order={order} disabled={locked} onSubmit={(payload) => mutate("propose", payload)} /> : null}</> : null}
    {pending ? <section className="flex min-w-0 flex-col gap-3" aria-label="Đề nghị đang chờ"><h3>{pending.kind === "cancel_with_refund" ? "Hủy đơn và hoàn" : "Hoàn tất đơn và hoàn"} {formatVnd(pending.refundAmountVnd)}</h3><p className="whitespace-pre-wrap wrap-anywhere">{pending.note}</p>
      <StatusBanner>{pending.respondBy ? `Đang chờ phản hồi đến ${formatTipTime(pending.respondBy)}` : "Thời hạn phản hồi đang tạm dừng"}</StatusBanner>
      {pending.stale ? <StatusBanner tone="warning">Đơn đã thay đổi. Đề nghị này không còn phù hợp để đồng ý.</StatusBanner> : null}
      <ActionBar>{pending.proposerRole === order.role ? <Button variant="outline" disabled={locked} onClick={() => mutate("withdrawProposal", {}, pending.id)}>Rút lại đề nghị</Button> : <>
        <Button disabled={locked || pending.stale || pendingExpired} onClick={() => setAccepting(true)}>Đồng ý</Button><Button variant="outline" disabled={locked || pendingExpired} onClick={() => mutate("respondProposal", { response: "decline" }, pending.id)}>Từ chối</Button>
        {accepting ? <Button disabled={locked || pending.stale || pendingExpired} onClick={() => mutate("respondProposal", { response: "accept" }, pending.id)}>Xác nhận đồng ý và kết thúc đơn</Button> : null}
      </>}</ActionBar></section> : null}
    {r?.proposals.history.length ? <details><summary>Lịch sử đề nghị</summary>{r.proposals.history.map((row) => <SummaryList key={row.id} items={[{ label: "Đề nghị", value: `${row.kind === "cancel_with_refund" ? "Hủy đơn và hoàn" : "Hoàn tất đơn và hoàn"} ${formatVnd(row.refundAmountVnd)}` }, { label: "Trạng thái", value: proposalStateLabels[row.state] }, { label: "Lời nhắn cho bên kia", value: row.note }]} />)}</details> : null}
    {r?.actions.canOpenDispute ? <>
      <ActionBar note={r.actions.disputeTriggerEndsAt ? <>Mở khiếu nại trước <time dateTime={disputeBefore(r.actions.disputeTrigger, r.actions.disputeTriggerEndsAt)}>{formatTipTime(disputeBefore(r.actions.disputeTrigger, r.actions.disputeTriggerEndsAt))}</time> (giờ Việt Nam).</> : undefined}><Button variant="outline" disabled={locked || !!r.actions.disputeTriggerEndsAt && disputeExpired} onClick={() => setDisputing(true)}>Mở khiếu nại</Button></ActionBar>
      {disputing ? <DisputeForm order={order} disabled={locked || !!r.actions.disputeTriggerEndsAt && disputeExpired} onSubmit={(payload) => mutate("openDispute", payload)} /> : null}
    </> : null}
    {r?.dispute ? <DisputePanel key={`${r.dispute.id}:${r.dispute.statements.length}:${r.dispute.state}`} dispute={r.dispute} role={order.role} disabled={locked} onStatement={(text) => mutate("addStatement", { text }, r.dispute!.id)} onWithdraw={() => mutate("withdrawDispute", {}, r.dispute!.id)} /> : null}
    {r?.actions.canCancelAfterSuspension && order.role === "buyer" ? <>
      <Button variant="outline" className="self-start" disabled={locked} onClick={() => setCancelling(true)}>Hủy đơn và yêu cầu hoàn tiền toàn bộ</Button>
      {cancelling ? <StatusBanner tone="warning"><p>Đơn sẽ đóng và cuộc trò chuyện chỉ còn để xem. Bạn không còn tải được tệp của nghệ sĩ. Khoản hoàn toàn bộ số tiền đã trả sẽ được ghi nhận; thao tác này không tự chuyển tiền.</p><Button disabled={locked} onClick={() => mutate("cancelAfterSuspension", { expectedVersion: order.version })}>Xác nhận hủy và yêu cầu hoàn tiền</Button></StatusBanner> : null}
    </> : null}
    {r?.refunds.map((refund) => <RefundPanel key={`${refund.obligationId}:${refund.version}`} order={order} refund={refund} banks={banks} disabled={locked} onRefresh={refresh} />)}
    {r && (r.lateClaim || lateEligible) ? <LateClaimPanel key={r.lateClaim?.id ?? "new"} order={order} claim={r.lateClaim} disabled={locked} onRefresh={refresh} /> : null}
    <a href="/help" className="text-sm underline">Chính sách và trợ giúp</a>
  </CardContent></Card>;
}
