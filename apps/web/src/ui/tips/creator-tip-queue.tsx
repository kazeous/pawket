"use client";

import type { CreatorTipProjection, CreatorTipQueue as Queue, PaymentIntentState } from "@pawket/payments";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { creatorTipPath, tipStateLabels } from "./creator-tip-client";
import { CreatorTipConfirmation } from "./creator-tip-confirmation";
import { formatTipTime, formatVnd } from "./tip-client";

function TipDetails({ tip }: Readonly<{ tip: CreatorTipProjection }>) {
  return <div className="flex min-w-0 flex-col gap-2"><Badge variant={tip.state === "confirmed" ? "default" : "secondary"}>{tipStateLabels[tip.state]}</Badge>
    <p className="text-sm text-muted-foreground">{tip.state === "confirmed" ? `${tip.confirmationSource === "sepay_automatic" ? "Tự động đối soát qua SePay" : tip.confirmationSource === "creator_reviewed_sepay" ? "Đã đối chiếu với SePay" : "Xác nhận thủ công"} lúc ${formatTipTime(tip.confirmedAt)}` : `Hạn chuyển khoản: ${formatTipTime(tip.expiresAt)}`}</p>
    {tip.state !== "confirmed" && tip.transferClaimedAt ? <p className="text-sm">Khách báo đã chuyển. Chưa xác minh tiền thực nhận.</p> : null}
    {tip.state === "confirmed" ? <div className="flex min-w-0 flex-col gap-1 whitespace-pre-wrap text-sm"><p>Tên khách: {tip.guestContent.name ?? "Không cung cấp"}</p><p>Lời nhắn: {tip.guestContent.message ?? "Không cung cấp"}</p></div> : <p className="text-sm text-muted-foreground">Tên và lời nhắn chỉ mở sau khi xác nhận tiền thực nhận.</p>}
  </div>;
}
export function CreatorTipQueue({ queue, state, paymentsEnabled, error }: Readonly<{ queue: Queue | null; state: PaymentIntentState; paymentsEnabled: boolean; error: string | null }>) {
  const router = useRouter(); const [refreshing, startTransition] = useTransition(); const [selected, setSelected] = useState<CreatorTipProjection | null>(null); const [notice, setNotice] = useState("");
  const refresh = () => startTransition(() => router.refresh());
  const action = (tip: CreatorTipProjection) => tip.state === "awaiting_transfer" && paymentsEnabled ? tip.settlementLane === "provider_bound"
    ? <a href="/creator/tips/sepay" className="text-sm underline">Đối soát qua SePay</a>
    : <Button type="button" variant="outline" onClick={() => setSelected(tip)}>Đối chiếu giao dịch</Button> : null;
  return <Card><CardHeader><CardTitle role="heading" aria-level={2}>Danh sách tip</CardTitle><CardDescription>Đối chiếu trực tiếp với ngân hàng trước khi xác nhận. Danh sách được chia thành từng trang.</CardDescription></CardHeader>
    <CardContent className="flex min-w-0 flex-col gap-4">
      <ToggleGroup multiple={false} variant="outline" value={[state]} disabled={refreshing} aria-label="Lọc trạng thái tip" className="max-w-full flex-wrap" onValueChange={(values) => {
        const next = values[0]; if (next && Object.hasOwn(tipStateLabels, next)) { setNotice(""); startTransition(() => router.push(creatorTipPath(next as PaymentIntentState))); }
      }}>{(Object.keys(tipStateLabels) as PaymentIntentState[]).map((value) => <ToggleGroupItem key={value} value={value}>{tipStateLabels[value]}</ToggleGroupItem>)}</ToggleGroup>
      {!paymentsEnabled ? <Alert role="note"><AlertTitle>Tip đang tạm đóng</AlertTitle><AlertDescription>Bạn vẫn xem được lịch sử. Thao tác xác nhận tiền đang tắt.</AlertDescription></Alert> : null}
      <p role="status" aria-live="polite">{refreshing ? "Đang tải danh sách tip…" : notice}</p>
      {refreshing ? <div aria-hidden="true" className="flex flex-col gap-2"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-3/4" /></div> : null}
      {error ? <Alert variant="destructive"><AlertTitle>Chưa tải được danh sách tip</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
      {queue?.items.length === 0 ? <Empty><EmptyHeader><EmptyTitle>Chưa có tip ở trạng thái này</EmptyTitle><EmptyDescription>Chọn trạng thái khác hoặc tải lại để kiểm tra.</EmptyDescription></EmptyHeader></Empty> : null}
      {queue && queue.items.length > 0 ? <>
        <div className="creator-tip-desktop"><Table className="table-fixed"><TableCaption>Tip của bạn — {tipStateLabels[state].toLocaleLowerCase("vi-VN")}</TableCaption><TableHeader><TableRow><TableHead scope="col">Tip và số tiền</TableHead><TableHead scope="col">Trạng thái và lời nhắn</TableHead><TableHead scope="col">Đối chiếu</TableHead></TableRow></TableHeader>
          <TableBody>{queue.items.map((tip) => <TableRow key={tip.id}><TableCell className="whitespace-normal align-top"><p className="break-all font-mono text-sm">{tip.reference}</p><p className="mt-2 font-semibold">{formatVnd(tip.amountVnd)}</p></TableCell><TableCell className="whitespace-normal align-top"><TipDetails tip={tip} /></TableCell><TableCell className="whitespace-normal align-top">{action(tip)}</TableCell></TableRow>)}</TableBody></Table></div>
        <div className="creator-tip-mobile flex flex-col gap-4">{queue.items.map((tip) => <article key={tip.id} className="flex min-w-0 flex-col gap-3 rounded-lg border p-3" aria-label={`Tip ${tip.reference}`}><h3 className="break-all font-mono text-sm">{tip.reference}</h3><p className="font-semibold">{formatVnd(tip.amountVnd)}</p><TipDetails tip={tip} />{action(tip)}</article>)}</div>
      </> : null}
    </CardContent><CardFooter className="flex flex-wrap gap-3"><Button type="button" variant="outline" disabled={refreshing} onClick={refresh}>Tải lại danh sách</Button>
      {queue?.nextCursor ? <Button variant="outline" nativeButton={false} render={<a href={creatorTipPath(state, queue.nextCursor)} referrerPolicy="no-referrer" />}>Trang tiếp theo</Button> : null}
      <Button variant="ghost" nativeButton={false} render={<a href={creatorTipPath(state)} referrerPolicy="no-referrer" />}>Về trang đầu</Button>
    </CardFooter>
    {selected ? <CreatorTipConfirmation key={selected.id} tip={selected} onClose={() => { setSelected(null); refresh(); }} onConfirmed={() => { setSelected(null); setNotice("Đã ghi nhận xác nhận tiền thực nhận. Chọn Đã xác nhận để xem tên và lời nhắn."); refresh(); }} /> : null}
  </Card>;
}
