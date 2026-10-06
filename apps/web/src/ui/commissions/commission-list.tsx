"use client";

import { useState } from "react";
import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { formatTipTime, formatVnd } from "@/ui/tips/tip-client";
import { commissionPath, commissionRead, ordersSchema, routeLabels, stateLabels, type OrdersView, type Role } from "./commission-client";
import { useCommissionSession } from "./commission-session";

export function CommissionList({ initial, role }: Readonly<{ initial: OrdersView; role: Role }>) {
  const [view, setView] = useState(initial); const [pending, setPending] = useState(false); const [failed, setFailed] = useState(false); const verify = useCommissionSession();
  async function load(older: boolean) {
    if (pending) return; setPending(true); setFailed(false);
    try {
      await verify(); const query = older && view.nextBefore ? `?beforeAt=${encodeURIComponent(view.nextBefore.createdAt)}&beforeId=${view.nextBefore.id}` : "";
      const result = await commissionRead(`/api/v1${commissionPath(role)}${query}`, ordersSchema); await verify(); setView(result.orders);
    } catch { setFailed(true); } finally { setPending(false); }
  }
  const groups = role === "buyer" ? [{ label: null, items: view.items }] : [
    { label: null, items: view.items.filter((order) => !["in_progress", "delivered", "completed"].includes(order.state)) },
    { label: "Cần xử lý", items: view.items.filter((order) => order.state === "in_progress" && !order.awaitingBuyer && !order.overdue) },
    { label: "Chờ người đặt", items: view.items.filter((order) => order.state === "delivered" || order.state === "in_progress" && order.awaitingBuyer && !order.overdue) },
    { label: "Quá hạn", items: view.items.filter((order) => order.state === "in_progress" && order.overdue) },
    { label: "Hoàn tất", items: view.items.filter((order) => order.state === "completed") },
  ];
  return <section className="flex min-w-0 flex-col gap-4" aria-label="Danh sách commission">
    <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={pending} onClick={() => void load(false)}>Tải đơn mới nhất</Button>{role === "creator" ? <Link prefetch={false} href="/creator/commissions/packages" className={buttonVariants({ variant: "outline" })}>Quản lý gói và suất</Link> : <Link prefetch={false} href="/creators" className={buttonVariants({ variant: "outline" })}>Tìm nghệ sĩ</Link>}</div>
    {failed ? <Alert variant="destructive"><AlertTitle>Chưa tải được danh sách</AlertTitle><AlertDescription>Dữ liệu bên dưới là lần tải trước. Thử tải lại.</AlertDescription></Alert> : null}
    {view.items.length === 0 ? <Empty><EmptyHeader><EmptyTitle>Chưa có commission</EmptyTitle><EmptyDescription>{role === "creator" ? "Các yêu cầu dành cho bạn sẽ xuất hiện tại đây." : "Yêu cầu và đơn bạn đặt sẽ xuất hiện tại đây."}</EmptyDescription></EmptyHeader></Empty> : groups.filter((group) => group.items.length).map((group) => <div key={group.label ?? "orders"} className="flex min-w-0 flex-col gap-3">
      {group.label ? <h2 className="text-xl font-semibold">{group.label}</h2> : null}
      <div className="grid min-w-0 gap-4 md:grid-cols-2">{group.items.map((order) => <Card key={order.id}><CardHeader><CardTitle role="heading" aria-level={group.label ? 3 : 2} className="wrap-anywhere"><a className="underline underline-offset-4" href={`${commissionPath(role)}/${order.id}`}>{order.title}</a></CardTitle><CardDescription>{routeLabels[order.route]} · {formatTipTime(order.createdAt)}</CardDescription></CardHeader><CardContent className="flex flex-col gap-3"><Badge variant="secondary">{stateLabels[order.state]}</Badge><p>{order.amountVnd === null ? "Chưa có giá chốt" : formatVnd(order.amountVnd)}</p>{order.expiresAt ? <p className="text-sm">Hạn phản hồi hoặc thanh toán: {formatTipTime(order.expiresAt)}</p> : null}{order.dueAt ? <p className="text-sm">Hạn thực hiện: {formatTipTime(order.dueAt)}</p> : null}</CardContent></Card>)}</div>
    </div>)}
    {view.nextBefore ? <Button variant="outline" className="self-start" disabled={pending} onClick={() => void load(true)}>Xem đơn cũ hơn</Button> : null}
    {pending ? <p role="status">Đang tải danh sách…</p> : null}
  </section>;
}
