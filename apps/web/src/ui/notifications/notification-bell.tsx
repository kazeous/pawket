"use client";

import Link from "next/link";
import { BellIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { tipRequest } from "../tips/tip-client";
import { summarySchema } from "./notification-client";

export function NotificationBell() {
  const [unread, setUnread] = useState<number | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void tipRequest("/api/v1/notifications/summary", { signal: controller.signal }).then((value) => {
      const result = summarySchema.safeParse(value);
      if (!controller.signal.aborted && result.success) setUnread(result.data.unread);
    }).catch(() => { /* Disabled or unavailable notifications leave the header unchanged. */ });
    return () => controller.abort();
  }, []);
  if (unread === null) return null;
  return <Link className="header-account-link inline-flex items-center gap-1.5" href="/notifications" aria-label={`Thông báo, ${unread} chưa đọc`}>
    <BellIcon className="size-4" aria-hidden="true" />
    {unread > 0 ? <Badge variant="secondary" aria-hidden="true">{unread >= 99 ? "99+" : unread}</Badge> : null}
  </Link>;
}
