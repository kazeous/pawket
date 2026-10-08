"use client";

import { useEffect, useRef, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { EvidenceView } from "@/ui/cases/evidence-tabs";
import { openCaseFile } from "@/ui/cases/case-client";

type Review = { title: string; body: string; ready: boolean; returnPath: string; expiresAt: string };
const labels: Record<string, string> = { observedAmountVnd: "Số tiền đã nhận (VND)", observedTransferReference: "Nội dung chuyển khoản", observedBankTransactionId: "Mã giao dịch ngân hàng",
  attestedReceived: "Đã kiểm tra nhận tiền", reason: "Lý do", action: "Thao tác", brief: "Yêu cầu sáng tác", terms: "Điều kiện", acceptTerms: "Đã đồng ý điều kiện",
  amountVnd: "Giá (VND)", title: "Tên", description: "Mô tả", enabled: "Bật nhận yêu cầu", capacityLimit: "Số đơn tối đa", presetsVnd: "Mức tip gợi ý",
  scope: "Phạm vi", deliverables: "Sản phẩm bàn giao", usageRights: "Quyền sử dụng", artistTerms: "Điều kiện nghệ sĩ", applicantExplanation: "Phản hồi cho người đăng ký", privateNote: "Ghi chú nội bộ",
  bankBin: "Mã ngân hàng", bankName: "Ngân hàng", accountNumber: "Số tài khoản", accountHolderLabel: "Chủ tài khoản", reference: "Nội dung chuyển khoản",
  expiresAt: "Hết hạn", operatingAccount: "Tài khoản nhận khoản xác minh", receivingAccount: "Tài khoản nhận tiền", maskedSuffix: "Số tài khoản đã che",
  artistDisplayName: "Tên nghệ sĩ", applicant: "Người đăng ký", contactEmail: "Email liên hệ", legalName: "Họ tên", phone: "Số điện thoại",
  portfolioLinks: "Liên kết portfolio", revision: "Hồ sơ", application: "Đơn đăng ký", state: "Trạng thái", status: "Trạng thái", reasonCode: "Lý do",
  expectedVersion: "Phiên bản thông tin", outcome: "Kết quả", actualAmountVnd: "Số tiền thực gửi (VND)", outboundBankReference: "Mã giao dịch hoàn tiền", attentionReason: "Lý do cần xử lý",
  section: "Mục bằng chứng", cursor: "Trang tin nhắn", disposition: "Cách tải tệp", refundAmountVnd: "Số tiền hoàn (VND)", reasoning: "Kết luận (hai bên sẽ thấy)",
  internalNote: "Ghi chú nội bộ (chỉ owner thấy)", rulingId: "Mã kết luận", newRefundAmountVnd: "Tổng số tiền hoàn mới (VND)", until: "Hạn mới" };
function detail(value: unknown): string { return typeof value === "boolean" ? value ? "Có" : "Không" : typeof value === "object" ? JSON.stringify(value, null, 2) : String(value ?? "—"); }
const caseValues: Record<string, string> = { rule: "Kết luận khiếu nại", correct: "Đính chính số tiền hoàn", question: "Gửi câu hỏi", extend: "Gia hạn phản hồi", accept_evidence: "Chấp nhận bằng chứng đã nhận tiền", require_resend: "Yêu cầu chuyển lại", waive: "Miễn nghĩa vụ hoàn tiền", extend_deadline: "Gia hạn chuyển hoàn tiền", rule_claim: "Kết luận thanh toán muộn",
  complete: "Hoàn tất đơn", close: "Đóng đơn", refund_owed: "Cần hoàn tiền", rejected: "Từ chối yêu cầu", order_summary: "Thông tin đơn hàng", thread_page: "Tin nhắn và bàn giao", resolution_records: "Khiếu nại và hoàn tiền", refund_destination: "Tài khoản nhận hoàn tiền", attachment: "Tải xuống", inline: "Xem tệp" };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
function PrivateDetails({ value }: { value: unknown }) {
  if (Array.isArray(value)) return <ul className="flex flex-col gap-2">{value.map((item, index) => <li key={index}><PrivateDetails value={item} /></li>)}</ul>;
  if (!record(value)) return <span className="whitespace-pre-wrap break-words">{detail(value)}</span>;
  return <dl className="flex flex-col gap-3">{Object.entries(value).filter(([name]) => !["id", "userId", "sessionId", "authorizationVersion", "requestId"].includes(name)).map(([name, item]) =>
    <div key={name}><dt className="text-sm font-medium">{labels[name] ?? name}</dt><dd className="text-sm text-muted-foreground"><PrivateDetails value={item} /></dd></div>)}</dl>;
}
export function CommandReview({ id, accountPortalUrl }: { id: string; accountPortalUrl: string }) {
  const [review, setReview] = useState<Review | null>(null); const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [done, setDone] = useState(false); const inFlight = useRef(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const resultAt = useRef(0);
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => { setResult(null); setMessage("Đã ẩn thông tin riêng tư. Quay lại trang trước để kiểm tra kết quả."); }, Math.max(0, resultAt.current + 300_000 - Date.now()));
    return () => clearTimeout(timer);
  }, [result]);
  useEffect(() => {
    let active = true;
    void fetch(`/api/v1/auth/commands/${id}`, { credentials: "same-origin", cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error(); const value = await response.json() as Review;
      if (active) setReview(value);
    }).catch(() => { if (active) setMessage("Thao tác đã hết hạn hoặc không thuộc phiên này. Hãy quay lại trang ban đầu để kiểm tra kết quả."); });
    return () => { active = false; };
  }, [id]);
  async function perform(kind: "authenticate" | "confirm" | "cancel") {
    if (inFlight.current || !review) return;
    inFlight.current = true; setBusy(true); setMessage(null);
    try {
      const response = await fetch(kind === "authenticate" ? "/api/v1/auth/oidc/step-up" : `/api/v1/auth/commands/${id}`, {
        method: kind === "cancel" ? "DELETE" : "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: kind === "authenticate" ? JSON.stringify({ pendingId: id }) : "{}", redirect: "error" });
      const value: unknown = await response.json();
      if (!response.ok) {
        if (kind === "confirm") {
          const refreshed = await fetch(`/api/v1/auth/commands/${id}`, { credentials: "same-origin", cache: "no-store" });
          if (refreshed.ok) setReview(await refreshed.json() as Review);
        }
        throw new Error();
      }
      if (kind === "authenticate") {
        if (!value || typeof value !== "object" || !("authorizationUrl" in value) || typeof value.authorizationUrl !== "string") throw new Error();
        const destination = new URL(value.authorizationUrl);
        if (destination.protocol !== "https:" || destination.origin !== new URL(accountPortalUrl).origin) throw new Error();
        window.location.assign(destination.href);
      } else if (kind === "cancel") window.location.replace(review.returnPath);
      else {
        // Case file grants are opened once and never enter React state or browser storage.
        if (review.title === "Xem tệp của vụ việc") { openCaseFile(value); setResult(null); setMessage("Đã mở lượt tải tệp. Quay lại vụ việc để tiếp tục."); }
        else { resultAt.current = Date.now(); setResult(record(value) ? value : null); setMessage("Đã xử lý yêu cầu. Kiểm tra kết quả bên dưới trước khi rời trang."); }
        setDone(true);
      }
    } catch { setMessage("Chưa thể hoàn tất yêu cầu. Xác thực lại nếu phiên đã hết hạn; nếu kết quả chưa rõ, quay lại kiểm tra trước khi tạo yêu cầu khác."); }
    finally { inFlight.current = false; setBusy(false); }
  }
  let fields: Array<[string, unknown]> = [];
  try { const value: unknown = JSON.parse(review?.body || "{}"); if (value && typeof value === "object" && !Array.isArray(value)) fields = Object.entries(value); } catch { /* Invalid stored content is not rendered as HTML. */ }
  let sepayUrl: string | null = null;
  try { if (typeof result?.authorizationUrl === "string") { const url = new URL(result.authorizationUrl); if (url.origin === "https://my.sepay.vn" && url.pathname === "/oauth/authorize" && !url.username && !url.password) sepayUrl = url.href; } } catch { /* No untrusted navigation. */ }
  const secret = typeof result?.webhookSecret === "string" && /^[A-Za-z0-9_-]{43}$/u.test(result.webhookSecret) ? result.webhookSecret : null;
  const endpoint = record(result?.connection) && typeof result.connection.webhookEndpoint === "string" ? result.connection.webhookEndpoint : null;
  return <Card>
    <CardHeader><CardTitle>{review?.title ?? "Xem lại thao tác"}</CardTitle><CardDescription>Nội dung đã được giữ lại. Xác thực tài khoản rồi kiểm tra trước khi xác nhận thực hiện.</CardDescription></CardHeader>
    <CardContent className="flex flex-col gap-4">
      {message ? <Alert variant={done ? "default" : "destructive"}><AlertDescription>{message}</AlertDescription></Alert> : null}
      {!review && !message ? <p role="status">Đang tải nội dung…</p> : null}
      {review && !done ? <><p className="text-sm text-muted-foreground">Có hiệu lực đến {new Date(review.expiresAt).toLocaleTimeString("vi-VN")}.</p>
        <dl className="flex flex-col gap-3">{fields.map(([name, value]) => <div key={name}><dt className="text-sm font-medium">{labels[name] ?? name}</dt><dd className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{["action", "outcome", "section", "disposition"].includes(name) && typeof value === "string" ? caseValues[value] ?? detail(value) : detail(value)}</dd></div>)}</dl></> : null}
      {sepayUrl ? <a className={buttonVariants()} href={sepayUrl} referrerPolicy="no-referrer">Tiếp tục kết nối tại SePay</a> : null}
      {result?.restartRequired === true ? <p>Phiên kết nối trước đã dùng. Quay lại trang SePay để bắt đầu phiên mới.</p> : null}
      {secret ? <section className="flex flex-col gap-3" aria-label="Cấu hình SePay">
        <p>Khóa ký chỉ hiển thị lần này và sẽ được ẩn sau 5 phút. Lưu khóa và cấu hình webhook trong SePay trước khi rời trang.</p>
        {endpoint ? <><label htmlFor="review-webhook-endpoint">Địa chỉ nhận thông báo giao dịch</label><Input id="review-webhook-endpoint" value={endpoint} readOnly /></> : null}
        <label htmlFor="review-webhook-secret">Khóa ký SePay</label><Input id="review-webhook-secret" value={secret} readOnly autoComplete="off" />
        <Button variant="outline" onClick={() => setResult((current) => current ? { ...current, webhookSecret: null } : null)}>Tôi đã lưu khóa, ẩn đi</Button>
      </section> : null}
      {result ? ["challenge", "destination", "detail"].map((name) => result[name] ? <section key={name} className="flex flex-col gap-3">
        <h2 className="font-medium">{name === "challenge" ? "Hướng dẫn xác minh — chỉ hiển thị lần này" : name === "destination" ? "Tài khoản hoàn tiền" : "Hồ sơ nghệ sĩ"}</h2>
        <PrivateDetails value={result[name]} />
        <Button variant="outline" onClick={() => setResult((current) => current ? { ...current, [name]: null } : null)}>Ẩn thông tin</Button>
      </section> : null) : null}
      {result && "evidence" in result ? <section className="flex flex-col gap-3"><h2 className="font-medium">Bằng chứng của vụ việc</h2>
        <p>Chỉ owner thấy. Nội dung sẽ ẩn sau 5 phút; quay lại vụ việc để tải tệp hoặc xem trang tin nhắn khác.</p><EvidenceView value={result.evidence} />
        <Button variant="outline" onClick={() => setResult(null)}>Ẩn bằng chứng</Button></section> : null}
    </CardContent>
    <CardFooter className="flex flex-wrap gap-2">
      {review && !done ? <><Button variant={review.ready ? "outline" : "default"} disabled={busy} onClick={() => void perform("authenticate")}>Xác thực lại với reyuuGAMES</Button>
        {review.ready ? <Button disabled={busy} onClick={() => void perform("confirm")}>Xác nhận thực hiện</Button> : null}
        <Button variant="ghost" disabled={busy} onClick={() => void perform("cancel")}>Hủy thao tác</Button></> : null}
      {done && review ? <Button onClick={() => window.location.replace(review.returnPath)}>Quay lại xem kết quả</Button> : null}
    </CardFooter>
  </Card>;
}
