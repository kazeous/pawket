import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { SummaryList } from "@/ui/summary-list";
import { formatTipTime, formatVnd } from "@/ui/tips/tip-client";
import { commissionPath, type Role } from "../commissions/commission-client";
import { claimStateLabels, refundStateLabels, type MyCasesView } from "../resolutions/resolution-client";

export function MyCases({ cases, orderRoles }: Readonly<{ cases: MyCasesView; orderRoles: Readonly<Record<string, Role>> }>) {
  const link = (orderId: string) => <a className="underline" href={`${commissionPath(orderRoles[orderId] ?? "buyer")}/${orderId}`}>Xem đơn và xử lý yêu cầu</a>;
  const disputeStates: Record<string, string> = { open: "Khiếu nại đang được Pawket xem xét", withdrawn: "Đã rút khiếu nại", settled: "Đã giải quyết theo thỏa thuận", ruled: "Đã có kết luận của Pawket", superseded: "Đã thay thế" };
  return <section className="flex min-w-0 flex-col gap-5" aria-label="Yêu cầu của tôi">
    {!cases.disputes.length && !cases.refunds.length && !cases.lateClaims.length ? <Empty><EmptyHeader><EmptyTitle>Chưa có yêu cầu</EmptyTitle><EmptyDescription>Khiếu nại, yêu cầu đối chiếu chuyển khoản và khoản hoàn tiền của bạn sẽ xuất hiện ở đây.</EmptyDescription></EmptyHeader></Empty> : null}
    {cases.disputes.map((row) => <Card key={row.id}><CardHeader><CardTitle role="heading" aria-level={2}>Khiếu nại</CardTitle><CardDescription>{disputeStates[row.state] ?? "Đã cập nhật"}</CardDescription></CardHeader><CardContent className="flex flex-col gap-3"><SummaryList items={[{ label: "Ngày mở", value: formatTipTime(row.openedAt) }, ...(row.closedAt ? [{ label: "Ngày kết thúc", value: formatTipTime(row.closedAt) }] : [])]} />{link(row.orderId)}</CardContent></Card>)}
    {cases.refunds.map((row) => <Card key={row.obligationId} id={`refund-${row.obligationId}`}><CardHeader><CardTitle role="heading" aria-level={2}>Hoàn tiền · {formatVnd(row.amountVnd)}</CardTitle><CardDescription>{refundStateLabels[row.state]}</CardDescription></CardHeader><CardContent className="flex flex-col gap-3"><SummaryList items={[{ label: "Nội dung chuyển khoản", value: row.reference }, ...(row.dueAt ? [{ label: "Hạn chuyển", value: formatTipTime(row.dueAt) }] : [])]} />{link(row.orderId)}</CardContent></Card>)}
    {cases.lateClaims.map((row) => <Card key={row.id}><CardHeader><CardTitle role="heading" aria-level={2}>Chuyển khoản sau khi đơn đóng</CardTitle><CardDescription>{claimStateLabels[row.state]}</CardDescription></CardHeader><CardContent className="flex flex-col gap-3"><SummaryList items={[{ label: "Số tiền đã báo", value: formatVnd(row.claimedAmountVnd) }, { label: "Ngày gửi", value: formatTipTime(row.filedAt) }]} />{link(row.orderId)}</CardContent></Card>)}
  </section>;
}
