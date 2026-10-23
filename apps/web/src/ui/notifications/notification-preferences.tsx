"use client";

import { useRef, useState } from "react";
import type { OptionalEmailCategory } from "@pawket/notifications";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { writeNotification } from "./notification-client";

type Preferences = Readonly<{ email: Partial<Record<OptionalEmailCategory, boolean>>; owner: boolean }>;
const categories: readonly { category: OptionalEmailCategory; title: string; label: string }[] = [
  { category: "orders", title: "Đơn commission", label: "Email về đơn commission" },
  { category: "messages", title: "Tin nhắn", label: "Email về tin nhắn" },
  { category: "deliveries", title: "Bản nháp và phản hồi", label: "Email về bản nháp và phản hồi" },
  { category: "disputes_refunds", title: "Khiếu nại và hoàn tiền", label: "Email về khiếu nại và hoàn tiền" },
  { category: "moderation", title: "Kiểm duyệt và kháng nghị", label: "Email về kiểm duyệt và kháng nghị" },
  { category: "owner_queue", title: "Hàng đợi xử lý", label: "Email về hàng đợi xử lý" },
];
export function NotificationPreferences({ initial }: Readonly<{ initial: Preferences }>) {
  const [email, setEmail] = useState(initial.email); const [busy, setBusy] = useState(false); const [status, setStatus] = useState<"saved" | "failed" | null>(null);
  const running = useRef(false);
  async function change(category: OptionalEmailCategory, enabled: boolean) {
    if (running.current) return; running.current = true; setBusy(true); setStatus(null);
    try { await writeNotification("/api/v1/notifications/preferences", "PUT", { channel: "email", category, enabled });
      setEmail((current) => ({ ...current, [category]: enabled })); setStatus("saved");
    } catch { setStatus("failed"); } finally { running.current = false; setBusy(false); }
  }
  return <section className="flex min-w-0 flex-col gap-5" aria-label="Cài đặt email thông báo" aria-busy={busy}>
    <p className="text-muted-foreground">Thông báo trong ứng dụng luôn nhận đầy đủ. Các lựa chọn dưới đây chỉ áp dụng cho email về cập nhật mới.</p>
    {status === "failed" ? <Alert variant="destructive"><AlertDescription>Chưa lưu được lựa chọn. Vui lòng thử lại.</AlertDescription></Alert> : null}
    {status === "saved" ? <p role="status">Đã lưu lựa chọn.</p> : null}
    <FieldGroup className="grid gap-4 md:grid-cols-2">{categories.filter((row) => row.category !== "owner_queue" || initial.owner).map((row) =>
      <Card key={row.category}><CardHeader><CardTitle role="heading" aria-level={2}>{row.title}</CardTitle>
        <CardDescription>Email về các cập nhật trong nhóm này.</CardDescription></CardHeader><CardContent>
        <Field orientation="horizontal" data-disabled={busy}><FieldContent><FieldLabel htmlFor={`email-${row.category}`}>{row.label}</FieldLabel>
          <FieldDescription>Thông báo cần bạn xử lý trong nhóm này luôn được gửi qua email.</FieldDescription></FieldContent>
          <Switch id={`email-${row.category}`} aria-label={row.label} checked={email[row.category] === true} disabled={busy}
            onCheckedChange={(enabled) => void change(row.category, enabled)} />
        </Field>
      </CardContent></Card>)}</FieldGroup>
    <div className="grid gap-4 md:grid-cols-2">{["Tip", "Tài khoản và bảo mật"].map((title) => <Card key={title}>
      <CardHeader><CardTitle role="heading" aria-level={2}>{title}</CardTitle><CardDescription>Luôn bật</CardDescription></CardHeader>
      <CardContent><p className="text-sm text-muted-foreground">Các email của nhóm này luôn được gửi và không có lựa chọn tắt.</p></CardContent>
    </Card>)}</div>
  </section>;
}
