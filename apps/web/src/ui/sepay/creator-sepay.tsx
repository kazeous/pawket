"use client";
import { useEffect, useRef, useState } from "react";
import type { SePayConnectionSnapshot, SePayReviewItem, SePayReviewQueue } from "@pawket/payments";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { formatTipTime, formatVnd, isRecord, requireTipDraftActor, tipRequest, TipRequestError } from "@/ui/tips/tip-client";
import { readSePayConnection, readSePayQueue, readSePaySnapshot, sepayErrorText, sepayStatusLabels } from "./sepay-client";

const base = "/api/v1/creator/tips/sepay";
function ReviewItem({ item, busy, enabled, submit }: { item: SePayReviewItem; busy: boolean; enabled: boolean; submit(item: SePayReviewItem, action: string, reason: string, attested: boolean): void }) {
  const [reason, setReason] = useState(""); const [attested, setAttested] = useState(false);
  return <article className="flex flex-col gap-3 rounded-lg border p-4"><div className="flex flex-wrap items-center gap-3"><Badge variant="secondary">{sepayStatusLabels[item.status]}</Badge><strong>{item.amountVnd === null ? "Chưa rõ số tiền" : formatVnd(item.amountVnd)}</strong></div>
    <p className="break-all font-mono text-sm">{item.reference ?? "Chưa có mã tip đầy đủ"}</p><p className="text-sm text-muted-foreground">Nhận thông tin: {formatTipTime(item.receivedAt)}</p>
    {item.reason ? <p>{sepayErrorText(item.reason)}</p> : null}
    {["review_required", "dismissed"].includes(item.status) ? <FieldGroup><Field data-disabled={busy || !enabled}><FieldLabel htmlFor={`reason-${item.id}`}>Lý do xử lý</FieldLabel><Input id={`reason-${item.id}`} value={reason} maxLength={500} disabled={busy || !enabled} onChange={(event) => setReason(event.target.value)} /></Field>
      {item.status === "review_required" ? <Field orientation="horizontal" data-disabled={busy || !enabled}><Checkbox id={`attest-${item.id}`} checked={attested} onCheckedChange={setAttested} disabled={busy || !enabled} /><FieldLabel htmlFor={`attest-${item.id}`}>Tôi đã kiểm tra và nhận được đúng khoản tiền này.</FieldLabel></Field> : null}
      <div className="flex flex-wrap gap-2">{item.status === "dismissed" ? <Button disabled={busy || !enabled || reason.trim().length < 3} onClick={() => submit(item, "reopen", reason.trim(), false)}>Mở lại kiểm tra</Button> : <>
        <Button disabled={busy || !enabled || !attested || reason.trim().length < 3} onClick={() => submit(item, "confirm", reason.trim(), attested)}>Đối chiếu lại và xác nhận</Button>
        <Button variant="outline" disabled={busy || !enabled || reason.trim().length < 3} onClick={() => submit(item, "retry", reason.trim(), false)}>Thử đối soát lại</Button>
        <Button variant="ghost" disabled={busy || !enabled || reason.trim().length < 3} onClick={() => submit(item, "dismiss", reason.trim(), false)}>Đóng kiểm tra</Button></>}</div>
      <p className="text-sm text-muted-foreground">Xác nhận luôn cần dữ liệu mới từ SePay khớp đầy đủ với tip. Đóng hoặc mở lại kiểm tra không đổi trạng thái thanh toán.</p>
    </FieldGroup> : null}
  </article>;
}
export function CreatorSePay({ initial, initialQueue, actorUserId, paymentsEnabled, initialError, oauthResult }: {
  initial: SePayConnectionSnapshot | null; initialQueue: SePayReviewQueue | null; actorUserId: string; paymentsEnabled: boolean; initialError: string | null; oauthResult: string | null;
}) {
  const [snapshot, setSnapshot] = useState(initial); const [queue, setQueue] = useState(initialQueue); const [status, setStatus] = useState("review_required");
  const [busy, setBusy] = useState(false); const [error, setError] = useState(initialError); const [notice, setNotice] = useState(oauthResult === "connected" ? "Đã nhận quyền kết nối. Tiếp tục chọn tài khoản nhận tiền." : oauthResult === "failed" ? "Kết nối chưa hoàn tất. Hãy bắt đầu kết nối lại." : "");
  const [secret, setSecret] = useState<{ value: string; connectionId: string; version: number } | null>(null); const [acknowledged, setAcknowledged] = useState(false);
  const [actorChanged, setActorChanged] = useState(false); const [totpRequired, setTotpRequired] = useState(false); const [totp, setTotp] = useState(""); const [totpInvalid, setTotpInvalid] = useState(false);
  const [accounts, setAccounts] = useState<Array<{ accountId: string; bankName: string; maskedSuffix: string; eligible: boolean }> | null>(null);
  const keys = useRef(new Map<string, string>()); const running = useRef(false);
  const connection = snapshot?.connection;
  useEffect(() => {
    let alive = true;
    const clear = () => setSecret(null);
    const check = () => {
      if (document.visibilityState !== "visible") return;
      void requireTipDraftActor(actorUserId).catch((cause: unknown) => {
        if (!alive) return;
        setSecret(null);
        if (cause instanceof TipRequestError && ["account_changed", "authentication_required"].includes(cause.code)) {
          setActorChanged(true); setSnapshot(null); setQueue(null); setAccounts(null); keys.current.clear(); setError(sepayErrorText(cause.code));
        }
      });
    };
    document.addEventListener("visibilitychange", check); window.addEventListener("focus", check); window.addEventListener("pagehide", clear);
    return () => { alive = false; document.removeEventListener("visibilitychange", check); window.removeEventListener("focus", check); window.removeEventListener("pagehide", clear); };
  }, [actorUserId]);
  async function refresh(nextStatus = status, cursor?: string) {
    await requireTipDraftActor(actorUserId);
    const [state, items] = await Promise.all([tipRequest(base), tipRequest(`${base}/reviews?status=${nextStatus}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, {}, 64_000)]);
    setSnapshot(readSePaySnapshot(state)); setQueue(readSePayQueue(items)); setStatus(nextStatus);
  }
  async function run(operation: () => Promise<void>) {
    if (running.current || actorChanged) return;
    running.current = true;
    setBusy(true); setError(null); setNotice("");
    try { await requireTipDraftActor(actorUserId); await operation(); }
    catch (cause) {
      const code = cause instanceof TipRequestError ? cause.code : "dependency_unavailable"; setError(sepayErrorText(code));
      if (code === "totp_required") setTotpRequired(true);
      if (["account_changed", "authentication_required"].includes(code)) { setSecret(null); setSnapshot(null); setQueue(null); setAccounts(null); keys.current.clear(); setActorChanged(true); }
    }
    finally { running.current = false; setBusy(false); }
  }
  async function post(path: string, body: Record<string, unknown>) {
    const identity = JSON.stringify([path, body]); let key = keys.current.get(identity); if (!key) { key = crypto.randomUUID(); keys.current.set(identity, key); }
    const result = await tipRequest(path, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) });
    keys.current.delete(identity); return result;
  }
  async function acceptChange(result: unknown) {
    if (!isRecord(result) || (result.webhookSecret !== null && (typeof result.webhookSecret !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(result.webhookSecret)))) throw new TipRequestError("dependency_unavailable");
    const changed = readSePayConnection(result.connection);
    await requireTipDraftActor(actorUserId);
    if (snapshot) setSnapshot({ ...snapshot, connection: changed });
    setSecret(typeof result.webhookSecret === "string" ? { value: result.webhookSecret, connectionId: changed.id, version: changed.version } : null); setAccounts(null); await refresh();
  }
  const change = (action: string) => void run(async () => {
    if (!connection) return; await acceptChange(await post(`${base}/${connection.id}/change`, { expectedVersion: connection.version, action }));
    setAcknowledged(false); setNotice("Đã cập nhật kết nối.");
  });
  return <div className="flex min-w-0 flex-col gap-6">
    {error ? <Alert variant="destructive"><AlertTitle>Chưa hoàn tất thao tác</AlertTitle><AlertDescription>{error} <a className={buttonVariants({ variant: "link" })} href="/sign-in/reauth" target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Đăng nhập lại trong tab mới</a>{actorChanged ? <a href="/creator/tips/sepay" className={buttonVariants({ variant: "link" })}>Tải lại trang</a> : null}</AlertDescription></Alert> : null}
    {totpRequired ? <form onSubmit={(event) => {
      event.preventDefault();
      if (!/^\d{6}$/u.test(totp)) { setTotpInvalid(true); return; }
      void run(async () => {
        try { await tipRequest("/api/auth/two-factor/verify-totp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: totp, trustDevice: false }) }); }
        catch { setTotpInvalid(true); throw new TipRequestError("totp_required"); }
        finally { setTotp(""); }
        setTotpRequired(false); setTotpInvalid(false); setNotice("Đã xác thực. Kiểm tra thông tin rồi thực hiện lại thao tác vừa chọn.");
      });
    }}><FieldGroup><Field data-invalid={totpInvalid || undefined} data-disabled={busy || actorChanged}><FieldLabel htmlFor="sepay-totp">Mã từ ứng dụng xác thực</FieldLabel><Input id="sepay-totp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={totp} disabled={busy || actorChanged} aria-invalid={totpInvalid} onChange={(event) => { setTotp(event.target.value); setTotpInvalid(false); }} /></Field><Button type="submit" disabled={busy || actorChanged}>Xác thực để tiếp tục</Button></FieldGroup></form> : null}
    <p role="status" aria-live="polite">{busy ? "Đang xử lý…" : notice}</p>
    <Card><CardHeader><CardTitle>Kết nối SePay</CardTitle><CardDescription>Nhận tiền trực tiếp vào tài khoản ngân hàng của bạn. SePay giúp đối chiếu giao dịch với từng tip.</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!snapshot?.available ? <Alert><AlertTitle>Chưa thể bật kết nối mới</AlertTitle><AlertDescription>{sepayErrorText(snapshot?.blockReason ?? "provider_contract_pending")}</AlertDescription></Alert> : null}
        {connection ? <><div className="flex flex-wrap gap-3"><Badge variant="secondary">{sepayStatusLabels[connection.status]}</Badge><p>{connection.bankName} · {connection.maskedSuffix}</p></div>
          {connection.cutoverAt ? <p>Tài khoản đã chuyển sang đối soát qua SePay từ {formatTipTime(connection.cutoverAt)}. Khi kết nối tạm dừng, tip thuộc luồng này cần kết nối lại để xác nhận.</p> : null}
          {connection.remoteRevocationStatus === "unknown" ? <p>Đã ngắt tại Pawket. Chưa xác minh việc thu hồi quyền tại SePay; hãy kiểm tra ứng dụng được cấp quyền trong tài khoản SePay của bạn.</p> : null}
          {["ready", "paused"].includes(connection.status) ? <FieldGroup><Field><FieldLabel htmlFor="sepay-endpoint">Địa chỉ nhận thông báo giao dịch</FieldLabel><Input id="sepay-endpoint" readOnly value={connection.webhookEndpoint} /></Field>
            {secret?.connectionId === connection.id && secret.version === connection.version ? <Field><FieldLabel htmlFor="sepay-secret">Khóa ký chỉ hiển thị lần này</FieldLabel><Input id="sepay-secret" readOnly value={secret.value} autoComplete="off" /><Button variant="outline" onClick={() => setSecret(null)}>Tôi đã lưu khóa, ẩn đi</Button></Field> : <p>Khóa ký không được hiển thị lại. Nếu chưa lưu, hãy tạo khóa mới và cập nhật trong SePay.</p>}
            <p className="text-sm text-muted-foreground">Trong SePay, tạo webhook cho đúng tài khoản nhận tiền, chỉ nhận tiền vào, định dạng JSON và xác thực HMAC. Lọc mã bắt đầu bằng PW với phần sau gồm 20 chữ hoặc số. Lần gửi thử chỉ kiểm tra kết nối.</p>
          </FieldGroup> : null}
          {connection.status === "ready" && !connection.automationEnabled ? <FieldGroup><Field orientation="horizontal"><Checkbox id="sepay-cutover" checked={acknowledged} onCheckedChange={setAcknowledged} disabled={busy || !paymentsEnabled} /><FieldLabel htmlFor="sepay-cutover">Tôi hiểu tip mới sẽ cần dữ liệu SePay để xác nhận, kể cả khi sau này tạm dừng hoặc ngắt kết nối.</FieldLabel></Field><p className="text-sm">Mọi tip thủ công đang chờ phải được xử lý hoặc hết hạn trước khi bật.</p><Button disabled={busy || !paymentsEnabled || !acknowledged || !snapshot?.available} onClick={() => change("enable_automation")}>Bật tự đối soát</Button></FieldGroup> : null}
          {accounts ? <div className="flex flex-col gap-3">{accounts.map((account) => <div key={account.accountId} className="flex flex-wrap items-center gap-3"><p>{account.bankName} · {account.maskedSuffix}</p><Button disabled={busy || !account.eligible} onClick={() => void run(async () => {
            await acceptChange(await post(`${base}/${connection.id}/bind`, { expectedVersion: connection.version, providerAccountId: account.accountId })); setNotice("Đã chọn tài khoản. Lưu khóa ký và cấu hình webhook trước khi bật tự đối soát.");
          })}>Dùng tài khoản này</Button>{!account.eligible ? <p className="text-sm">Chưa khớp tài khoản đã xác minh hoặc chưa đủ điều kiện kết nối.</p> : null}</div>)}</div> : null}
        </> : <p>Bạn chưa kết nối SePay.</p>}
      </CardContent><CardFooter className="flex flex-wrap gap-3">
        {(!connection || ["disconnected", "reconnect_required", "setup_pending"].includes(connection.status)) ? <Button disabled={busy || !snapshot?.available} onClick={() => void run(async () => {
          const result = await post(`${base}/start`, {}); if (!isRecord(result)) throw new TipRequestError("dependency_unavailable");
          if (result.restartRequired === true) { setNotice("Phiên kết nối trước đã dùng. Bấm kết nối để bắt đầu phiên mới."); return; }
          if (typeof result.authorizationUrl !== "string") throw new TipRequestError("dependency_unavailable");
          const url = new URL(result.authorizationUrl); if (url.origin !== "https://my.sepay.vn" || url.pathname !== "/oauth/authorize") throw new TipRequestError("dependency_unavailable");
          window.location.assign(url.href);
        })}>Kết nối SePay</Button> : null}
        {connection?.status === "setup_pending" ? <Button variant="outline" disabled={busy || !paymentsEnabled} onClick={() => void run(async () => {
          const result = await tipRequest(`${base}/${connection.id}/accounts`);
          if (!isRecord(result) || !Array.isArray(result.accounts) || result.accounts.length > 100 || !Number.isSafeInteger(result.connectionVersion)) throw new TipRequestError("dependency_unavailable");
          const choices = result.accounts.map((item: unknown) => { if (!isRecord(item) || typeof item.accountId !== "string" || !/^[1-9][0-9]{0,31}$/u.test(item.accountId) || typeof item.bankName !== "string" || typeof item.maskedSuffix !== "string" || typeof item.eligible !== "boolean") throw new TipRequestError("dependency_unavailable"); return { accountId: item.accountId, bankName: item.bankName, maskedSuffix: item.maskedSuffix, eligible: item.eligible }; });
          await refresh(); setAccounts(choices); if (!choices.length) setNotice("Chưa tìm thấy tài khoản có thể kết nối.");
        })}>Chọn tài khoản nhận tiền</Button> : null}
        {connection?.status === "ready" ? <Button variant="outline" disabled={busy || !paymentsEnabled} onClick={() => change("pause")}>Tạm dừng</Button> : null}
        {connection?.status === "paused" ? <Button disabled={busy || !paymentsEnabled} onClick={() => change("resume")}>Tiếp tục kết nối</Button> : null}
        {connection && ["ready", "paused"].includes(connection.status) ? <Button variant="outline" disabled={busy || !paymentsEnabled} onClick={() => change("rotate_secret")}>Tạo khóa ký mới</Button> : null}
        {connection && connection.status !== "disconnected" ? <Button variant="outline" disabled={busy || !paymentsEnabled} onClick={() => change("disconnect")}>Ngắt kết nối</Button> : null}
      </CardFooter></Card>
    <Card><CardHeader><CardTitle>Kiểm tra giao dịch</CardTitle><CardDescription>Chỉ các thông báo có mã Pawket được đưa vào đây. Giao dịch thiếu mã có thể không xuất hiện; bạn vẫn cần kiểm tra tài khoản ngân hàng.</CardDescription></CardHeader><CardContent className="flex flex-col gap-4">
      <ToggleGroup aria-label="Trạng thái đối soát" variant="outline" value={[status]} disabled={busy || actorChanged} className="flex-wrap" onValueChange={(values) => { const selected = values[0]; if (selected && selected !== status) void run(() => refresh(selected)); }}>{["review_required", "pending", "processing", "confirmed", "dismissed"].map((value) => <ToggleGroupItem key={value} value={value}>{sepayStatusLabels[value]}</ToggleGroupItem>)}</ToggleGroup>
      {queue?.items.length === 0 ? <Empty><EmptyHeader><EmptyTitle>Chưa có giao dịch ở trạng thái này</EmptyTitle><EmptyDescription>Thông tin nhận được sẽ xuất hiện khi có giao dịch phù hợp.</EmptyDescription></EmptyHeader></Empty> : null}
      {queue?.items.map((item) => <ReviewItem key={`${item.id}:${item.version}`} item={item} busy={busy} enabled={paymentsEnabled} submit={(row, action, reason, attested) => void run(async () => {
        const result = await post(`${base}/reviews/${row.id}/${action === "confirm" ? "confirm" : "decide"}`, { expectedVersion: row.version, reason, ...(action === "confirm" ? { attestedReceived: attested } : { action }) });
        await refresh(); setNotice(action === "confirm" && isRecord(result) && result.outcome !== "confirmed" ? "Giao dịch vẫn cần kiểm tra. Chưa xác nhận thanh toán." : "Đã ghi nhận kết quả xử lý.");
      })} />)}
    </CardContent><CardFooter className="flex flex-wrap gap-3"><Button variant="outline" disabled={busy || actorChanged} onClick={() => void run(() => refresh())}>Tải lại</Button>{queue?.nextCursor ? <Button variant="outline" disabled={busy || actorChanged} onClick={() => void run(() => refresh(status, queue.nextCursor!))}>Trang tiếp theo</Button> : null}</CardFooter></Card>
  </div>;
}
