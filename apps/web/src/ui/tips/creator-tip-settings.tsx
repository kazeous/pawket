"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatVnd, isRecord, tipRequest, TipRequestError } from "./tip-client";
import { readCreatorTipSettings, type CreatorTipSettingsView } from "./creator-tip-client";
export function CreatorTipSettings({ initial, editable }: Readonly<{ initial: CreatorTipSettingsView | null; editable: boolean }>) {
  const router = useRouter(); const id = useId(); const busy = useRef(false);
  const [saved, setSaved] = useState(initial); const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [pending, setPending] = useState(false); const [locked, setLocked] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const attempt = useRef<{ key: string; body: { expectedRevision: number; enabled: boolean; presetsVnd: readonly number[] } } | null>(null);
  const available = editable && saved?.available === true;
  async function save(event: FormEvent) {
    event.preventDefault(); if (!saved || !available || busy.current) return;
    busy.current = true; setPending(true); setLocked(true); setError(""); setNotice("");
    try {
      if (!attempt.current) attempt.current = { key: crypto.randomUUID(), body: { expectedRevision: saved.revisionNumber, enabled, presetsVnd: saved.presetsVnd } };
      const response = await tipRequest("/api/v1/creator/tip-settings", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": attempt.current.key }, body: JSON.stringify(attempt.current.body) });
      const result = readCreatorTipSettings(isRecord(response) ? response.settings : null);
      if (result.revisionNumber < 1 || result.enabled !== attempt.current.body.enabled) throw new TipRequestError("dependency_unavailable");
      setSaved({ ...result, available: saved.available }); setEnabled(result.enabled); setNotice(result.enabled ? "Đã bật nhận tip cho trang của bạn." : "Đã dừng nhận tip mới. Các tip đã tạo vẫn giữ nguyên lịch sử.");
      attempt.current = null; setLocked(false);
    } catch (failure) {
      const code = failure instanceof TipRequestError ? failure.code : "dependency_unavailable";
      setError(code === "recent_auth_required" ? "Hãy đăng nhập lại để xác thực gần đây, rồi mở lại trang tip để lưu cài đặt." : code === "version_conflict" ? "Cài đặt đã thay đổi ở nơi khác. Tải lại dữ liệu trước khi chỉnh sửa." : code === "payments_disabled" ? "Tính năng tip đang tạm đóng." : code === "rate_limited" ? "Bạn đã thử nhiều lần. Vui lòng đợi trước khi thử lại." : "Chưa nhận được kết quả lưu. Thử lại cùng lần lưu này hoặc tải lại dữ liệu để kiểm tra cài đặt hiện tại.");
      if (["recent_auth_required", "version_conflict", "invalid_request", "not_available", "payments_disabled"].includes(code)) { attempt.current = null; setLocked(false); }
    } finally { busy.current = false; setPending(false); }
  }
  return <form method="post" action="/api/v1/creator/tip-settings" onSubmit={(event) => void save(event)} aria-labelledby={`${id}-title`}>
    <Card><CardHeader><CardTitle id={`${id}-title`} role="heading" aria-level={2}>Cài đặt nhận tip</CardTitle><CardDescription>Nhận tiền trực tiếp vào tài khoản ngân hàng đã xác minh của bạn.</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!available ? <Alert role="note"><AlertTitle>Chưa thể thay đổi cài đặt nhận tip</AlertTitle><AlertDescription>Cần trang đã xuất bản, tài khoản nhận tiền đã xác minh và tính năng tip đang mở. Lịch sử tip hiện có vẫn được giữ lại.</AlertDescription></Alert> : null}
        {saved ? <FieldGroup><Field data-disabled={!available || locked || undefined}>
          <FieldLabel id={`${id}-mode`}>Nhận tip mới</FieldLabel><ToggleGroup multiple={false} variant="outline" value={[enabled ? "enabled" : "disabled"]} disabled={!available || locked} aria-labelledby={`${id}-mode`} className="max-w-full flex-wrap"
            onValueChange={(values) => { if (values[0]) setEnabled(values[0] === "enabled"); }}>
            <ToggleGroupItem value="enabled">Bật nhận tip</ToggleGroupItem><ToggleGroupItem value="disabled">Dừng nhận tip mới</ToggleGroupItem>
          </ToggleGroup><FieldDescription>Dừng nhận tip mới không hủy hay xác nhận các yêu cầu đã tạo.</FieldDescription>
        </Field><Field><FieldLabel>Số tiền gợi ý</FieldLabel><div className="flex flex-wrap gap-2">{saved.presetsVnd.map((v) => <Badge key={v} variant="secondary">{formatVnd(v)}</Badge>)}</div>
          <FieldDescription>Khách có thể chọn số tiền nguyên từ {formatVnd(saved.minimumVnd)} đến {formatVnd(saved.maximumVnd)}.</FieldDescription></Field></FieldGroup> : null}
        {error ? <Alert variant="destructive"><AlertTitle>Chưa lưu được cài đặt</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
        <p role="status" aria-live="polite">{notice}</p>
        <noscript>Bật JavaScript để lưu cài đặt nhận tip.</noscript>
      </CardContent>
      <CardFooter className="flex flex-wrap gap-3"><Button type="submit" disabled={!available || pending || (!locked && enabled === saved?.enabled)}>{pending ? <Spinner data-icon="inline-start" /> : null}{pending ? "Đang lưu…" : locked ? "Thử lại lần lưu này" : "Lưu cài đặt tip"}</Button>
        {error ? <><Button type="button" variant="outline" disabled={pending} onClick={() => router.refresh()}>Tải lại dữ liệu</Button><Button variant="ghost" nativeButton={false} render={<a href="/sign-in" referrerPolicy="no-referrer" />}>Đăng nhập lại</Button></> : null}
      </CardFooter>
    </Card>
  </form>;
}
