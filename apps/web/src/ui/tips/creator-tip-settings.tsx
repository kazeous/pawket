"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatVnd, isRecord, requireTipDraftActor, tipRequest, TipRequestError } from "./tip-client";
import { readCreatorTipSettings, type CreatorTipSettingsView } from "./creator-tip-client";
export function CreatorTipSettings({ initial, editable, initialActorUserId }: Readonly<{ initial: CreatorTipSettingsView | null; editable: boolean; initialActorUserId: string }>) {
  const id = useId(); const busy = useRef(false);
  const [saved, setSaved] = useState(initial); const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [presets, setPresets] = useState<readonly number[]>(initial?.effectivePresetsVnd ?? []);
  const [conflict, setConflict] = useState(false); const [presetsError, setPresetsError] = useState("");
  const [pending, setPending] = useState(false); const [locked, setLocked] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const attempt = useRef<{ key: string; body: { expectedRevision: number; expectedPolicyRevision: number; enabled: boolean; presetsVnd: readonly number[] } } | null>(null);
  const available = editable && saved?.available === true && saved.effectivePolicy !== null;
  async function reload() {
    if (busy.current) return; busy.current = true; setPending(true); setError("");
    try {
      await requireTipDraftActor(initialActorUserId);
      const result = await tipRequest("/api/v1/creator/tip-settings");
      const value = isRecord(result) ? result.settings : null;
      if (!isRecord(value) || typeof value.available !== "boolean") throw new TipRequestError("dependency_unavailable");
      setSaved({ ...readCreatorTipSettings(value), available: value.available }); setConflict(false); setLocked(false); attempt.current = null;
      setNotice("Đã tải chính sách mới. Lựa chọn đang chỉnh sửa được giữ lại; hãy đối chiếu và chọn đúng ba mức trước khi lưu.");
    } catch (failure) { setError(failure instanceof TipRequestError && failure.code === "account_changed" ? "Bạn đang đăng nhập bằng tài khoản khác. Đăng nhập lại đúng tài khoản đã mở trang này; lựa chọn đang nhập vẫn được giữ lại." : "Chưa tải được cài đặt mới. Đăng nhập lại đúng tài khoản rồi thử lại."); }
    finally { busy.current = false; setPending(false); }
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!saved?.effectivePolicy || !available || busy.current || conflict) return;
    if (!attempt.current && (presets.length !== 3 || new Set(presets).size !== 3 || presets.some((v) => !saved.effectivePolicy!.allowedPresetsVnd.includes(v)))) { setPresetsError("Chọn đúng ba mức trong chính sách hiện tại."); document.getElementById(`${id}-choices`)?.focus(); return; }
    setPresetsError("");
    busy.current = true; setPending(true); setLocked(true); setError(""); setNotice("");
    try {
      await requireTipDraftActor(initialActorUserId);
      if (!attempt.current) attempt.current = { key: crypto.randomUUID(), body: { expectedRevision: saved.revisionNumber, expectedPolicyRevision: saved.effectivePolicy.revisionNumber, enabled, presetsVnd: [...presets] } };
      const response = await tipRequest("/api/v1/creator/tip-settings", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": attempt.current.key }, body: JSON.stringify(attempt.current.body) });
      const result = readCreatorTipSettings(isRecord(response) ? response.settings : null);
      if (result.revisionNumber !== attempt.current.body.expectedRevision + 1 || result.enabled !== attempt.current.body.enabled || JSON.stringify(result.presetsVnd) !== JSON.stringify(attempt.current.body.presetsVnd)) throw new TipRequestError("dependency_unavailable");
      setSaved({ ...result, available: saved.available }); setEnabled(result.enabled); setPresets(result.effectivePresetsVnd); setNotice(result.enabled ? "Đã bật nhận tip và lưu ba mức gợi ý." : "Đã dừng nhận tip mới. Các tip đã tạo vẫn giữ nguyên lịch sử.");
      attempt.current = null; setLocked(false);
    } catch (failure) {
      const code = failure instanceof TipRequestError ? failure.code : "dependency_unavailable";
      setError(["recent_auth_required", "authentication_required"].includes(code) ? "Đăng nhập lại đúng tài khoản trong tab mới, rồi quay lại tab này để lưu. Lựa chọn đang nhập được giữ nguyên." : code === "account_changed" ? "Bạn đang đăng nhập bằng tài khoản khác. Đăng nhập lại đúng tài khoản đã mở trang này; lựa chọn đang nhập vẫn được giữ lại." : ["version_conflict", "policy_changed"].includes(code) ? "Cài đặt hoặc chính sách đã thay đổi. Tải lại dữ liệu và đối chiếu ba mức gợi ý trước khi lưu." : code === "payments_disabled" ? "Tính năng tip đang tạm đóng." : code === "rate_limited" ? "Bạn đã thử nhiều lần. Vui lòng đợi trước khi thử lại." : "Chưa nhận được kết quả lưu. Thử lại cùng lần lưu này để kiểm tra cài đặt hiện tại.");
      if (["version_conflict", "policy_changed"].includes(code)) setConflict(true);
      // Authentication and availability are checked before replay resolution;
      // they cannot prove a previously lost response did not commit.
      if (["version_conflict", "policy_changed", "invalid_request"].includes(code)) { attempt.current = null; setLocked(false); }
    } finally { busy.current = false; setPending(false); }
  }
  return <form method="post" action="/api/v1/creator/tip-settings" onSubmit={(event) => void save(event)} aria-labelledby={`${id}-title`}>
    <Card><CardHeader><CardTitle id={`${id}-title`} role="heading" aria-level={2}>Cài đặt nhận tip</CardTitle><CardDescription>Nhận tiền trực tiếp vào tài khoản ngân hàng đã xác minh của bạn.</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!available ? <Alert role="note"><AlertTitle>Chưa thể thay đổi cài đặt nhận tip</AlertTitle><AlertDescription>Cần trang đã xuất bản, tài khoản nhận tiền đã xác minh và tính năng tip đang mở. Lịch sử tip hiện có vẫn được giữ lại.</AlertDescription></Alert> : null}
        {saved?.presetsFallback ? <Alert role="note"><AlertTitle>Mức gợi ý đang dùng mặc định mới</AlertTitle><AlertDescription>Một số mức gợi ý đã thay đổi theo chính sách mới. Trang của bạn đang dùng ba mức mặc định. Bạn có thể chọn lại bên dưới.</AlertDescription></Alert> : null}
        {saved ? <FieldGroup><Field data-disabled={!available || locked || conflict || undefined}>
          <FieldLabel id={`${id}-mode`}>Nhận tip mới</FieldLabel><ToggleGroup multiple={false} variant="outline" value={[enabled ? "enabled" : "disabled"]} disabled={!available || locked || conflict} aria-labelledby={`${id}-mode`} className="max-w-full flex-wrap"
            onValueChange={(values) => { if (values[0]) setEnabled(values[0] === "enabled"); }}>
            <ToggleGroupItem value="enabled">Bật nhận tip</ToggleGroupItem><ToggleGroupItem value="disabled">Dừng nhận tip mới</ToggleGroupItem>
          </ToggleGroup><FieldDescription>Dừng nhận tip mới không hủy hay xác nhận các yêu cầu đã tạo.</FieldDescription>
        </Field><Field><FieldLabel>Ba mức đã lưu</FieldLabel><div className="flex flex-wrap gap-2">{saved.presetsVnd.map((v) => <Badge key={v} variant="secondary">{formatVnd(v)}</Badge>)}</div></Field>
        <Field><FieldLabel>Ba mức đang hiển thị cho khách</FieldLabel><div className="flex flex-wrap gap-2">{saved.effectivePresetsVnd.map((v) => <Badge key={v} variant="secondary">{formatVnd(v)}</Badge>)}</div><FieldDescription>{saved.effectivePolicy ? `Khách có thể chọn số tiền nguyên từ ${formatVnd(saved.effectivePolicy.minimumVnd)} đến ${formatVnd(saved.effectivePolicy.maximumVnd)}. Chính sách phiên bản ${saved.effectivePolicy.revisionNumber}.` : "Chưa có chính sách hợp lệ để nhận tip mới."}</FieldDescription></Field>
        {saved.effectivePolicy ? <Field data-invalid={!!presetsError} data-disabled={!available || locked || conflict || undefined}><FieldLabel id={`${id}-choices-label`}>Chọn ba mức gợi ý</FieldLabel><ToggleGroup id={`${id}-choices`} tabIndex={-1} multiple variant="outline" className="max-w-full flex-wrap" value={presets.map(String)} disabled={!available || locked || conflict} aria-labelledby={`${id}-choices-label`} aria-invalid={!!presetsError} aria-describedby={`${id}-choices-help`} onValueChange={(values) => { setPresets(values.map(Number)); setPresetsError(""); }}>
          {saved.effectivePolicy.allowedPresetsVnd.map((value) => <ToggleGroupItem value={String(value)} key={value} aria-label={`Gợi ý ${formatVnd(value)}`}>{formatVnd(value)}</ToggleGroupItem>)}
        </ToggleGroup><FieldDescription id={`${id}-choices-help`}>Chọn đúng ba mức. Lựa chọn được lưu khi bạn bấm lưu cài đặt.</FieldDescription>{presets.some((value) => !saved.effectivePolicy!.allowedPresetsVnd.includes(value)) ? <><FieldDescription>Lựa chọn đang nhập không còn hợp lệ: {presets.filter((value) => !saved.effectivePolicy!.allowedPresetsVnd.includes(value)).map(formatVnd).join(", ")}. Bạn có thể dùng ba mức đang hiển thị rồi chọn lại.</FieldDescription><Button type="button" variant="outline" disabled={!available || locked || conflict} onClick={() => { setPresets(saved.effectivePresetsVnd); setPresetsError(""); }}>Dùng ba mức đang hiển thị</Button></> : null}<FieldError>{presetsError}</FieldError></Field> : null}</FieldGroup> : null}
        {error ? <Alert variant="destructive"><AlertTitle>Chưa lưu được cài đặt</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
        <p role="status" aria-live="polite">{notice}</p>
        <noscript>Bật JavaScript để lưu cài đặt nhận tip.</noscript>
      </CardContent>
      <CardFooter className="flex flex-wrap gap-3"><Button type="submit" disabled={!available || pending || conflict || (!locked && enabled === saved?.enabled && JSON.stringify(presets) === JSON.stringify(saved?.presetsVnd))}>{pending ? <Spinner data-icon="inline-start" /> : null}{pending ? "Đang lưu…" : locked ? "Thử lại lần lưu này" : "Lưu cài đặt tip"}</Button>
        {error ? <><Button type="button" variant="outline" disabled={pending || locked} onClick={() => void reload()}>Tải lại dữ liệu</Button><a className={buttonVariants({ variant: "ghost" })} href="/sign-in/reauth" target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Đăng nhập lại trong tab mới</a></> : null}
      </CardFooter>
    </Card>
  </form>;
}
