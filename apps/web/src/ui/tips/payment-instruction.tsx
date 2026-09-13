"use client";

import type { TipInstructionProjection } from "@pawket/payments";
import { CopyIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { Component, useEffect, useState, type ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatTipTime, formatVnd } from "./tip-client";

const LocalQr = dynamic(() => import("./tip-qr"), { ssr: false, loading: () => <div role="status" aria-label="Đang tạo VietQR"><Skeleton className="size-60 max-w-full" /></div> });
class QrBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <Alert><AlertTitle>Chưa hiển thị được QR</AlertTitle><AlertDescription>Bạn có thể nhập thông tin chuyển khoản bên cạnh trong ứng dụng ngân hàng.</AlertDescription></Alert> : this.props.children; }
}
export function PaymentInstruction({ instruction, footer }: Readonly<{ instruction: TipInstructionProjection; footer?: ReactNode }>) {
  const [copyStatus, setCopyStatus] = useState("");
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    const check = () => setExpired(Date.now() >= Date.parse(instruction.expiresAt));
    const timer = setTimeout(check, Math.max(0, Date.parse(instruction.expiresAt) - Date.now()));
    document.addEventListener("visibilitychange", check);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", check); };
  }, [instruction.expiresAt]);
  const facts = [
    ["Ngân hàng", instruction.destination.bankName], ["Số tài khoản", instruction.destination.accountNumber],
    ["Tên người nhận", instruction.destination.accountName], ["Số tiền", formatVnd(instruction.amountVnd)],
    ["Nội dung chuyển khoản", instruction.reference],
  ] as const;
  async function copy(label: string, value: string) {
    try { await navigator.clipboard.writeText(value); setCopyStatus(`Đã sao chép ${label.toLocaleLowerCase("vi-VN")}.`); }
    catch { setCopyStatus("Chưa sao chép được. Bạn có thể chọn và sao chép trực tiếp phần chữ."); }
  }
  if (expired) return <Card><CardHeader><CardTitle role="heading" aria-level={2}>Yêu cầu đã hết hạn</CardTitle><CardDescription>Không tiếp tục chuyển khoản theo hướng dẫn này.</CardDescription></CardHeader>
    <CardContent><Alert><AlertTitle>Nếu đã chuyển tiền</AlertTitle><AlertDescription>Liên hệ nghệ sĩ để đối chiếu; trạng thái hết hạn không xác định tiền đã đến hay chưa.</AlertDescription></Alert></CardContent><CardFooter>{footer}</CardFooter></Card>;
  return <Card aria-labelledby="tip-instruction-title">
    <CardHeader><CardTitle id="tip-instruction-title" role="heading" aria-level={2}>Chuyển khoản cho {instruction.creator.displayName}</CardTitle>
      <CardDescription>Hết hạn lúc {formatTipTime(instruction.expiresAt)} (giờ Việt Nam).</CardDescription></CardHeader>
    <CardContent className="flex flex-col gap-5">
      <Badge variant="secondary">Chờ nghệ sĩ xác nhận</Badge>
      <Alert role="note"><AlertTitle>Tiền đến trực tiếp nghệ sĩ</AlertTitle><AlertDescription>Pawket không giữ tiền. Kiểm tra tên người nhận, số tiền và nội dung trong ứng dụng ngân hàng trước khi chuyển. Tạo QR chưa có nghĩa là đã thanh toán.</AlertDescription></Alert>
      <div className="grid gap-6 md:grid-cols-[15rem_minmax(0,1fr)]">
        <QrBoundary><LocalQr payload={instruction.qrPayload} /></QrBoundary>
        <dl className="flex min-w-0 flex-col gap-4">{facts.map(([label, value]) => <div key={label} className="min-w-0">
          <dt>{label}</dt><dd className="flex min-w-0 flex-wrap items-start justify-between gap-2">
            <span className="min-w-0 flex-[1_1_12rem] break-all select-text">{value}</span>
            {label !== "Ngân hàng" && label !== "Tên người nhận" ? <Button type="button" variant="outline" size="sm" onClick={() => void copy(label, label === "Số tiền" ? String(instruction.amountVnd) : value)} aria-label={`Sao chép ${label.toLocaleLowerCase("vi-VN")}`}><CopyIcon data-icon="inline-start" aria-hidden="true" />Sao chép</Button> : null}
          </dd>
        </div>)}</dl>
      </div>
      <p role="status" aria-live="polite">{copyStatus}</p>
    </CardContent>
    <CardFooter className="flex flex-col items-start gap-3">{footer ?? <p>Chỉ chuyển đúng số tiền và nội dung đã ghi. Mỗi yêu cầu dùng cho một lần chuyển khoản.</p>}</CardFooter>
  </Card>;
}
