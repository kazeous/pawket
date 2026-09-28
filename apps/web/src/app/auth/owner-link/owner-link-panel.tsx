"use client";
import { type FormEvent, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";

export function OwnerLinkPanel({ accountPortalUrl }: { accountPortalUrl: string }) {
  const [invitation, setInvitation] = useState(""); const [busy, setBusy] = useState(false); const [failed, setFailed] = useState(false); const running = useRef(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (running.current || !/^[A-Za-z0-9_-]{43}$/u.test(invitation)) return;
    running.current = true; setBusy(true); setFailed(false);
    try {
      const response = await fetch("/api/v1/auth/oidc/owner-link", { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ invitation, returnPath: "/settings/security" }) });
      setInvitation(""); const result: unknown = await response.json();
      if (!response.ok || !result || typeof result !== "object" || !("authorizationUrl" in result) || typeof result.authorizationUrl !== "string") throw new Error();
      const target = new URL(result.authorizationUrl);
      if (target.protocol !== "https:" || target.origin !== new URL(accountPortalUrl).origin || target.username || target.password) throw new Error();
      window.location.assign(target.href);
    } catch { setInvitation(""); setFailed(true); setBusy(false); running.current = false; }
  }
  return <Card><CardHeader><CardTitle>Liên kết owner với reyuuGAMES</CardTitle><CardDescription>Dùng lời mời do người vận hành cấp cho tài khoản owner hiện có. Bạn sẽ đăng nhập và xác thực TOTP tại reyuuGAMES.</CardDescription></CardHeader>
    <form onSubmit={(event) => void submit(event)}><CardContent className="flex flex-col gap-3">
      <label htmlFor="owner-link-invitation">Mã mời liên kết một lần</label><Input id="owner-link-invitation" type="password" autoComplete="off" value={invitation} maxLength={43} disabled={busy} onChange={(event) => setInvitation(event.target.value)} required />
      <p className="text-sm text-muted-foreground">Mã có hiệu lực 30 phút. Không gửi mã qua chat hoặc đưa vào địa chỉ trang.</p>
      {failed ? <Alert variant="destructive"><AlertDescription>Chưa thể dùng lời mời này. Kiểm tra lời mời còn hiệu lực và dịch vụ tài khoản đang hoạt động.</AlertDescription></Alert> : null}
    </CardContent><CardFooter><Button type="submit" disabled={busy || !/^[A-Za-z0-9_-]{43}$/u.test(invitation)}>{busy ? "Đang chuyển đến reyuuGAMES…" : "Xác minh tài khoản owner"}</Button></CardFooter></form>
  </Card>;
}
