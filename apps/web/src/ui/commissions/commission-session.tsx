"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { requireTipDraftActor, tipRequest, TipRequestError } from "@/ui/tips/tip-client";
import { commissionErrorText } from "./commission-client";

const SessionContext = createContext<(() => Promise<void>) | null>(null);
export function CommissionSession({ actorUserId, children }: Readonly<{ actorUserId: string; children: ReactNode }>) {
  const [status, setStatus] = useState("checking"); const alive = useRef(true); const invalidated = useRef(false);
  const verify = useCallback(async () => {
    if (invalidated.current) throw new TipRequestError("account_changed");
    try { await requireTipDraftActor(actorUserId); if (alive.current && !invalidated.current) setStatus("ready"); }
    catch (error) {
      const code = error instanceof TipRequestError ? error.code : "dependency_unavailable";
      if (code === "account_changed") invalidated.current = true;
      if (alive.current) setStatus(code); throw error;
    }
  }, [actorUserId]);
  useEffect(() => {
    alive.current = true;
    const check = () => { if (document.visibilityState === "visible") void verify().catch(() => undefined); };
    const visibility = () => { if (document.visibilityState !== "visible") setStatus("checking"); else check(); };
    check(); const timer = setInterval(check, 30_000);
    document.addEventListener("visibilitychange", visibility); window.addEventListener("focus", check); window.addEventListener("pageshow", check);
    return () => { alive.current = false; clearInterval(timer); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("focus", check); window.removeEventListener("pageshow", check); };
  }, [verify]);
  return <SessionContext.Provider value={verify}>
    {status !== "ready" ? <Alert><AlertTitle>{status === "checking" ? "Đang kiểm tra phiên đăng nhập…" : "Cần kiểm tra tài khoản"}</AlertTitle>
      <AlertDescription>{status !== "checking" ? <><p>{commissionErrorText(status)}</p><a href="/sign-in" target="_blank" rel="noopener noreferrer" className="underline">Đăng nhập trong tab mới</a><Button variant="outline" onClick={() => void verify().catch(() => undefined)}>Kiểm tra lại phiên</Button></> : "Nội dung riêng tư sẽ hiện khi xác minh xong."}</AlertDescription></Alert> : null}
    {status !== "account_changed" ? <div hidden={status !== "ready"}>{children}</div> : null}
  </SessionContext.Provider>;
}
export function useCommissionSession() {
  const verify = useContext(SessionContext); if (!verify) throw new Error("Commission session boundary required"); return verify;
}
type Attempt = { path: string; key: string; body: string; done(value: unknown): void };
export function useCommissionCommand() {
  const verify = useCommissionSession(); const attempt = useRef<Attempt | null>(null); const running = useRef(false);
  const [pending, setPending] = useState(false); const [locked, setLocked] = useState(false); const [code, setCode] = useState<string | null>(null);
  async function send() {
    if (running.current || !attempt.current) return;
    running.current = true; setPending(true); setLocked(true); setCode(null);
    try {
      await verify(); const a = attempt.current;
      const value = await tipRequest(a.path, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": a.key }, body: a.body }, 131_072);
      await verify(); a.done(value); attempt.current = null; setLocked(false);
    } catch (error) {
      const failure = error instanceof TipRequestError ? error.code : "dependency_unavailable"; setCode(failure);
      // An unknown outcome keeps the original bytes and key, including across reauthentication.
      if (!["dependency_unavailable", "authentication_required", "recent_auth_required", "totp_required", "account_changed"].includes(failure)) { attempt.current = null; setLocked(false); }
    } finally { running.current = false; setPending(false); }
  }
  function execute(path: string, payload: unknown, done: (value: unknown) => void) {
    if (running.current || attempt.current) return;
    attempt.current = { path, key: crypto.randomUUID(), body: JSON.stringify(payload), done }; void send();
  }
  return { execute, retry: send, pending, locked, code };
}
export function CommandFeedback({ command }: Readonly<{ command: ReturnType<typeof useCommissionCommand> }>) {
  const verify = useCommissionSession(); const [totp, setTotp] = useState(""); const [verifying, setVerifying] = useState(false); const [totpError, setTotpError] = useState(false);
  const feedback = useRef<HTMLDivElement>(null);
  useEffect(() => { if (command.code) feedback.current?.focus(); }, [command.code]);
  if (!command.code && !command.pending) return null;
  async function verifyTotp() {
    if (verifying || !/^\d{6}$/u.test(totp)) { setTotpError(true); return; }
    setVerifying(true); setTotpError(false);
    try { await verify(); await tipRequest("/api/auth/two-factor/verify-totp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: totp, trustDevice: false }) }); await verify(); await command.retry(); }
    catch { setTotpError(true); } finally { setTotp(""); setVerifying(false); }
  }
  return <Alert ref={feedback} tabIndex={-1} role={command.pending ? "status" : "alert"} variant={command.pending ? "default" : "destructive"}>
    <AlertTitle>{command.pending ? "Đang kiểm tra kết quả…" : "Chưa hoàn tất thao tác"}</AlertTitle><AlertDescription className="flex flex-col items-start gap-3">
      {command.code ? <p>{commissionErrorText(command.code)}</p> : null}
      {command.code === "dependency_unavailable" ? <p>Giữ trang này mở. Lần kiểm tra tiếp theo dùng cùng yêu cầu, không tạo thêm đơn hoặc thanh toán.</p> : null}
      {["authentication_required", "recent_auth_required"].includes(command.code ?? "") ? <a className={buttonVariants({ variant: "outline" })} href="/sign-in" target="_blank" rel="noopener noreferrer">Đăng nhập lại trong tab mới</a> : null}
      {command.code === "totp_required" ? <div className="flex flex-col gap-2"><Field data-invalid={totpError || undefined}><FieldLabel htmlFor="commission-totp">Mã từ ứng dụng xác thực</FieldLabel><Input id="commission-totp" inputMode="numeric" autoComplete="one-time-code" value={totp} maxLength={6} aria-invalid={totpError} onChange={(e) => setTotp(e.target.value)} disabled={verifying} /></Field>{totpError ? <p>Chưa xác minh được mã. Kiểm tra mã 6 chữ số mới.</p> : null}<Button disabled={verifying} onClick={() => void verifyTotp()}>Xác thực và kiểm tra kết quả</Button></div> : null}
      {command.locked && !command.pending && command.code !== "totp_required" && command.code !== "account_changed" ? <Button onClick={() => void command.retry()} variant="outline">Kiểm tra lại cùng yêu cầu</Button> : null}
    </AlertDescription>
  </Alert>;
}
