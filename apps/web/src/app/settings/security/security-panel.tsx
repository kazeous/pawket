"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";

type Session = { id: string; deviceLabel: string; createdAt: string; lastUsedAt: string; isCurrent: boolean };
export function SecurityPanel({ accountPortalUrl, mfaStatus }: { accountPortalUrl: string; mfaStatus: string }) {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/v1/me/sessions", { credentials: "same-origin", signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error();
      const payload = await response.json() as { sessions: Session[] }; setSessions(payload.sessions);
    }).catch(() => { if (!controller.signal.aborted) setMessage("Chưa tải được các phiên. Hãy đăng nhập lại hoặc tải lại trang."); });
    return () => controller.abort();
  }, []);
  async function revoke(sessionId?: string) {
    if (working) return;
    setWorking(true); setMessage(null);
    try {
      const response = await fetch(sessionId ? `/api/v1/me/sessions/${encodeURIComponent(sessionId)}` : "/api/v1/me/sessions", { method: "DELETE", credentials: "same-origin" });
      if (!response.ok) throw new Error();
      if (!sessionId || sessions?.find((session) => session.id === sessionId)?.isCurrent) window.location.replace("/sign-in");
      else setSessions((current) => current?.filter((session) => session.id !== sessionId) ?? null);
    } catch { setMessage("Chưa thể thu hồi phiên. Hãy thử lại."); }
    finally { setWorking(false); }
  }
  async function logout() {
    setWorking(true); setMessage(null);
    try {
      const response = await fetch("/api/v1/auth/oidc/logout", { method: "POST", credentials: "same-origin" });
      if (!response.ok) throw new Error();
      window.location.replace("/sign-in");
    } catch { setMessage("Chưa thể đăng xuất. Hãy thử lại."); setWorking(false); }
  }
  return <div className="flex flex-col gap-6">
    {message ? <Alert variant="destructive"><AlertDescription>{message} <Link href="/sign-in?returnTo=/settings/security">Đăng nhập</Link></AlertDescription></Alert> : null}
    <Card><CardHeader><CardTitle>Tài khoản chung</CardTitle><CardDescription>Quản lý email, mật khẩu và xác thực hai bước tại reyuuGAMES.</CardDescription></CardHeader>
      <CardContent><p>{mfaStatus === "enrolled" ? "Xác thực hai bước đang được bật trong tài khoản reyuuGAMES." : mfaStatus === "not_enrolled" ? "Bạn chưa bật xác thực hai bước (ứng dụng xác thực hoặc khóa truy cập) trong tài khoản reyuuGAMES." : "Chưa xác nhận được trạng thái xác thực hai bước."}</p><p>Để đăng xuất các ứng dụng dùng chung tài khoản, hãy quản lý phiên tại trang tài khoản reyuuGAMES.</p></CardContent>
      <CardFooter><a className={buttonVariants({ variant: "outline" })} href={accountPortalUrl}>Quản lý tài khoản chung</a></CardFooter>
    </Card>
    <Card><CardHeader><CardTitle>Phiên Pawket</CardTitle><CardDescription>Thu hồi tại đây chỉ kết thúc quyền truy cập Pawket trên thiết bị đó.</CardDescription></CardHeader>
      <CardContent><div className="flex flex-col gap-4">{sessions === null ? <p role="status">Đang tải các phiên…</p> : sessions.length === 0 ? <p>Không có phiên đang hoạt động.</p> : sessions.map((session) => <div className="flex flex-wrap items-center justify-between gap-3" key={session.id}>
        <div><p>{session.deviceLabel}{session.isCurrent ? " · Thiết bị hiện tại" : ""}</p><p>Lần dùng gần nhất: {new Date(session.lastUsedAt).toLocaleString("vi-VN")}</p></div>
        <Button variant="outline" type="button" disabled={working} onClick={() => void revoke(session.id)} aria-label={`Thu hồi phiên ${session.deviceLabel}${session.isCurrent ? " hiện tại" : ""}`}>Thu hồi phiên</Button>
      </div>)}</div></CardContent>
      <CardFooter className="flex flex-wrap gap-3"><Button type="button" disabled={working} onClick={() => void logout()}>Đăng xuất Pawket</Button><Button type="button" variant="outline" disabled={working} onClick={() => void revoke()}>Đăng xuất mọi phiên Pawket</Button></CardFooter>
    </Card>
  </div>;
}
