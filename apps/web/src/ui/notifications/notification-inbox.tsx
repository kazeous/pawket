"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type MouseEvent } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { formatTipTime } from "../tips/tip-client";
import { markNotificationRead, readNotificationPage, type InboxPage } from "./notification-client";

export function NotificationInbox({ initial }: Readonly<{ initial: InboxPage }>) {
  const router = useRouter(); const [items, setItems] = useState(initial.items); const [cursor, setCursor] = useState(initial.nextCursor);
  const [busy, setBusy] = useState(false); const [failed, setFailed] = useState(false); const running = useRef(false);
  async function run(work: () => Promise<void>) {
    if (running.current) return; running.current = true; setBusy(true); setFailed(false);
    try { await work(); } catch { setFailed(true); } finally { running.current = false; setBusy(false); }
  }
  function open(event: MouseEvent<HTMLAnchorElement>, item: InboxPage["items"][number]) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) { void markNotificationRead({ ids: [item.id] }).catch(() => undefined); return; }
    event.preventDefault();
    void run(async () => {
      await markNotificationRead({ ids: [item.id] }); setItems((current) => current.map((row) => row.id === item.id ? { ...row, read: true } : row));
      router.push(item.linkPath);
    });
  }
  return <section className="flex min-w-0 flex-col gap-5" aria-label="Hộp thông báo" aria-busy={busy}>
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="outline" disabled={busy} onClick={() => void run(async () => {
        await markNotificationRead({ all: true }); setItems((current) => current.map((item) => ({ ...item, read: true })));
      })}>Đánh dấu tất cả là đã đọc</Button>
      <Link className="underline" href="/settings/notifications">Cài đặt thông báo</Link>
    </div>
    {failed ? <Alert variant="destructive"><AlertDescription>Chưa cập nhật được thông báo. Vui lòng thử lại.</AlertDescription></Alert> : null}
    {!items.length ? <Empty><EmptyHeader><EmptyTitle>Chưa có thông báo</EmptyTitle><EmptyDescription>Các cập nhật mới sẽ xuất hiện tại đây.</EmptyDescription></EmptyHeader></Empty> : null}
    <ol className="flex min-w-0 flex-col gap-3">{items.map((item) => <li key={item.id} data-unread={!item.read}>
      <Card><CardHeader><CardTitle role="heading" aria-level={2}>
        <Link className="underline" href={item.linkPath} onClick={(event) => open(event, item)}>{item.title}</Link>
      </CardTitle><CardDescription className="flex flex-wrap items-center gap-2">
        <time dateTime={item.createdAt}>{formatTipTime(item.createdAt)}</time>
        {!item.read ? <Badge variant="secondary">Chưa đọc</Badge> : null}
        {item.actionRequired ? <Badge variant="outline">Cần bạn xử lý</Badge> : null}
        {item.count > 1 ? <span>{item.count} tin nhắn</span> : null}
      </CardDescription></CardHeader><CardContent><p>{item.body}</p>
        <Link className="underline" href={item.linkPath} onClick={(event) => open(event, item)}>{item.actionLabel}</Link>
      </CardContent></Card>
    </li>)}</ol>
    {cursor ? <Button variant="outline" disabled={busy} onClick={() => void run(async () => {
      const page = await readNotificationPage(cursor);
      setItems((current) => [...new Map([...current, ...page.items].map((item) => [item.id, item])).values()]); setCursor(page.nextCursor);
    })}>Xem thêm</Button> : null}
  </section>;
}
