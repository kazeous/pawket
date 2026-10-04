"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";

export function SignInPanel({ accountPortalUrl, mode = "start", initialMessage = null, returnTo = "/settings/security", reauthenticate = false }: {
  accountPortalUrl: string; mode?: "start" | "lease"; initialMessage?: string | null; returnTo?: string;
  /** Make the account site ask for the password and TOTP again instead of reusing its current session. */
  reauthenticate?: boolean;
}) {
  const forceLogin = reauthenticate && mode === "start";
  const [message, setMessage] = useState(initialMessage);
  const [working, setWorking] = useState(false);
  const started = useRef(false);
  const begin = useCallback(async () => {
    if (started.current) return;
    started.current = true; setWorking(true); setMessage(null);
    try {
      const response = await fetch(`/api/v1/auth/oidc/${mode}`, { method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ returnPath: returnTo, ...(forceLogin ? { reauthenticate: true } : {}) }) });
      const result = await response.json() as { authorizationUrl?: string };
      if (!response.ok || !result.authorizationUrl) throw new Error();
      const destination = new URL(result.authorizationUrl);
      if (destination.protocol !== "https:" || destination.origin !== new URL(accountPortalUrl).origin) throw new Error();
      window.location.assign(destination.href);
    } catch {
      started.current = false; setWorking(false);
      setMessage("Chưa thể kết nối dịch vụ tài khoản. Bạn có thể thử lại hoặc tiếp tục xem các trang công khai.");
    }
  }, [accountPortalUrl, mode, returnTo, forceLogin]);
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled && mode === "lease" && !initialMessage) void begin(); });
    return () => { cancelled = true; };
  }, [begin, mode, initialMessage]);
  return <Card>
    <CardHeader><CardTitle>Tài khoản reyuuGAMES</CardTitle><CardDescription>Đăng nhập và xác thực hai bước tại trang tài khoản chung.</CardDescription></CardHeader>
    <CardContent>{message ? <Alert variant="destructive"><AlertDescription>{message}</AlertDescription></Alert> : <p>Pawket dùng tài khoản reyuuGAMES. Mật khẩu và mã xác thực chỉ được nhập tại trang tài khoản reyuuGAMES.</p>}</CardContent>
    <CardFooter><Button type="button" disabled={working} onClick={() => void begin()}>{working ? "Đang chuyển đến trang tài khoản…" : mode === "lease" ? "Tiếp tục phiên đăng nhập" : forceLogin ? "Đăng nhập lại với reyuuGAMES" : "Đăng nhập với reyuuGAMES"}</Button></CardFooter>
  </Card>;
}
