"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { PaymentInstruction } from "./payment-instruction";
import { formatTipTime, formatVnd, isRecord, readTipReceipt, tipErrorText, tipRequest, TipRequestError, type TipReceiptPageState } from "./tip-client";

const statusText = { awaiting_transfer: "Chờ nghệ sĩ xác nhận", confirmed: "Nghệ sĩ đã xác nhận nhận tiền", expired: "Yêu cầu đã hết hạn", rejected: "Yêu cầu không được chấp nhận" } as const;
function unavailableText(code: string) {
  if (code === "missing_access") return "Trình duyệt này chưa có quyền xem phiếu tip. Nếu gửi tip không đăng nhập, hãy mở lại bằng trình duyệt đã tạo tip và giữ cookie. Nếu gửi bằng tài khoản, hãy đăng nhập tài khoản đó.";
  if (code === "not_available") return "Không mở được phiếu tip bằng quyền truy cập hiện tại. Kiểm tra lại trình duyệt hoặc tài khoản đã tạo tip. Đường dẫn này không tự cấp quyền xem.";
  return tipErrorText(code);
}

export function TipReceipt({ reference, initial }: Readonly<{ reference: string | null; initial: TipReceiptPageState }>) {
  const [state, setState] = useState(initial); const [operation, setOperation] = useState<"refresh" | "claim" | null>(null);
  const [notice, setNotice] = useState(""); const [error, setError] = useState(""); const busy = useRef(false);
  const expiresAt = state.kind === "ready" && state.data.receipt.state === "awaiting_transfer" ? state.data.receipt.expiresAt : null;
  useEffect(() => {
    if (!expiresAt) return;
    const check = () => { if (Date.now() >= Date.parse(expiresAt)) setState((current) => current.kind === "ready" && current.data.receipt.state === "awaiting_transfer"
      ? { kind: "ready", data: { ...current.data, receipt: { ...current.data.receipt, state: "expired" }, instruction: null } } : current); };
    const timer = setTimeout(check, Math.max(0, Date.parse(expiresAt) - Date.now()));
    document.addEventListener("visibilitychange", check);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", check); };
  }, [expiresAt]);

  async function perform(action: "refresh" | "claim") {
    if (!reference || busy.current) return;
    busy.current = true; setOperation(action); setError(""); setNotice("");
    try {
      if (action === "claim") {
        const result = await tipRequest(`/api/v1/tips/${reference}/transfer-claims`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        if (!isRecord(result) || result.paymentConfirmed !== false || !isRecord(result.claim) || result.claim.authoritative !== false || typeof result.claim.claimedAt !== "string" || !Number.isFinite(Date.parse(result.claim.claimedAt))) throw new TipRequestError("dependency_unavailable");
        setNotice("Đã gửi thông báo cho nghệ sĩ. Đây chưa phải xác nhận nhận tiền.");
      }
      setState({ kind: "ready", data: readTipReceipt(await tipRequest(`/api/v1/tips/${reference}`), reference) });
    } catch (failure) {
      const code = failure instanceof TipRequestError ? failure.code : "dependency_unavailable";
      if (action === "refresh" || ["not_available", "payments_disabled"].includes(code)) setState({ kind: "unavailable", code });
      else setError(tipErrorText(code));
    } finally { busy.current = false; setOperation(null); }
  }
  const refresh = <Button type="button" variant="outline" disabled={!!operation || !reference} onClick={() => void perform("refresh")}>
    {operation === "refresh" ? <Spinner data-icon="inline-start" /> : null}{operation === "refresh" ? "Đang kiểm tra…" : "Kiểm tra trạng thái"}
  </Button>;
  if (state.kind === "unavailable") return <Card data-tip-surface><CardHeader><CardTitle role="heading" aria-level={2}>Chưa xem được phiếu tip</CardTitle>
    <CardDescription>{unavailableText(state.code)}</CardDescription></CardHeader>
    <CardContent><Alert><AlertTitle>Giữ quyền truy cập của bạn</AlertTitle><AlertDescription>Không chia sẻ cookie hay thông tin đăng nhập. Mở liên kết từ trình duyệt khác không khôi phục quyền của khách.</AlertDescription></Alert>{notice ? <p role="status">{notice}</p> : null}</CardContent>
    <CardFooter className="flex flex-wrap gap-3">{refresh}<Button variant="ghost" nativeButton={false} render={<a href="/sign-in" referrerPolicy="no-referrer" />}>Đăng nhập</Button></CardFooter></Card>;
  const { receipt, instruction, paymentsEnabled } = state.data;
  return <div data-tip-surface className="flex min-w-0 flex-col gap-5">
    <Card><CardHeader><CardTitle role="heading" aria-level={2}>Tip cho {receipt.creator.displayName}</CardTitle>
      <CardDescription>@{receipt.creator.handle}</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Badge variant={receipt.state === "confirmed" ? "default" : "secondary"}>{statusText[receipt.state]}</Badge>
        <dl className="flex min-w-0 flex-col gap-3"><div><dt>Số tiền</dt><dd>{formatVnd(receipt.amountVnd)}</dd></div>
          <div><dt>Mã nội dung chuyển khoản</dt><dd className="break-all select-text">{receipt.reference}</dd></div>
          <div><dt>Hạn chuyển khoản</dt><dd>{formatTipTime(receipt.expiresAt)} (giờ Việt Nam)</dd></div>
          {receipt.confirmedAt ? <div><dt>Nghệ sĩ xác nhận lúc</dt><dd>{formatTipTime(receipt.confirmedAt)}</dd></div> : null}</dl>
        {!paymentsEnabled ? <Alert role="note"><AlertTitle>Tính năng tip đang tạm đóng</AlertTitle><AlertDescription>Bạn vẫn xem được lịch sử của mình. Hiện không có hướng dẫn chuyển khoản hoặc thao tác thanh toán mới.</AlertDescription></Alert> : null}
        {receipt.state === "confirmed" ? <Alert role="note"><AlertTitle>Đã được nghệ sĩ đối chiếu thủ công</AlertTitle><AlertDescription>Nghệ sĩ đã xác nhận nhận tiền trong tài khoản của họ. Bạn không cần chuyển lại cho yêu cầu này.</AlertDescription></Alert> : null}
        {receipt.state === "expired" || receipt.state === "rejected" ? <Alert><AlertTitle>Không tiếp tục chuyển khoản cho yêu cầu này</AlertTitle><AlertDescription>Nếu đã chuyển tiền, hãy liên hệ nghệ sĩ để đối chiếu. Trạng thái này không chứng minh rằng tiền chưa đến hoặc đã được hoàn.</AlertDescription></Alert> : null}
        {receipt.state === "awaiting_transfer" ? <Alert role="note"><AlertTitle>{receipt.transferClaimedAt ? "Bạn đã báo đã chuyển khoản" : "Nghệ sĩ sẽ kiểm tra khoản chuyển"}</AlertTitle><AlertDescription>{receipt.transferClaimedAt ? `Đã báo lúc ${formatTipTime(receipt.transferClaimedAt)}. ` : ""}Thông báo của bạn không phải bằng chứng ngân hàng và không xác nhận thanh toán.</AlertDescription></Alert> : null}
        {receipt.state === "awaiting_transfer" && paymentsEnabled && !instruction ? <Alert><AlertTitle>Hướng dẫn chuyển khoản hiện không khả dụng</AlertTitle><AlertDescription>Không sử dụng QR đã lưu. Kiểm tra lại trạng thái hoặc liên hệ nghệ sĩ nếu đã chuyển tiền.</AlertDescription></Alert> : null}
        {error ? <Alert variant="destructive"><AlertTitle>Chưa hoàn tất thao tác</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
        <p role="status" aria-live="polite">{notice}</p>
        <noscript>Bật JavaScript để kiểm tra trạng thái và gửi thông báo đã chuyển khoản.</noscript>
      </CardContent>
      <CardFooter className="flex flex-wrap gap-3">{refresh}
        {paymentsEnabled && receipt.state === "awaiting_transfer" ? <Button type="button" variant="ghost" disabled={!!operation || !!receipt.transferClaimedAt} onClick={() => void perform("claim")}>
          {operation === "claim" ? <Spinner data-icon="inline-start" /> : null}{receipt.transferClaimedAt ? "Đã báo đã chuyển khoản" : operation === "claim" ? "Đang gửi thông báo…" : "Tôi đã chuyển khoản"}
        </Button> : null}
      </CardFooter>
    </Card>
    {operation === "refresh" ? <div role="status" aria-label="Đang tải hướng dẫn"><Skeleton className="h-60 w-full" /></div> : instruction ? <PaymentInstruction instruction={instruction} /> : null}
  </div>;
}
