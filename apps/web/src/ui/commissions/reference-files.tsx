"use client";

import { useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { tipRequest, TipRequestError } from "@/ui/tips/tip-client";
import { commissionErrorText, type OrderView } from "./commission-client";
import { useCommissionSession } from "./commission-session";

const MAX_FILES = 10; const MAX_BYTES = 25 * 1024 * 1024; const ACCEPT = "image/jpeg,image/png,image/webp,image/gif,application/pdf";
const grantSchema = z.object({ upload: z.object({ fileId: z.uuid(), url: z.url(), requiredHeaders: z.record(z.string(), z.string()), expiresAt: z.string() }) });
const fileSchema = z.object({ file: z.object({ fileId: z.uuid(), state: z.string(), rejectionReason: z.string().nullable() }) });
const REJECTIONS: Record<string, string> = {
  malware: "Phát hiện mã độc đã biết. Tệp đã bị xóa.", type_not_allowed: "Chỉ nhận JPEG, PNG, WebP, GIF hoặc PDF (kiểm tra theo nội dung tệp).",
  size_mismatch: "Tải lên chưa hoàn tất. Hãy chọn lại tệp.", encrypted_archive: "Tệp có mật khẩu không được chấp nhận.",
  limits_exceeded: "Tệp quá phức tạp để kiểm tra. Hãy gửi tệp khác.", scan_failed: "Chưa kiểm tra được trong 24 giờ. Hãy tải lại.", expired: "Liên kết tải lên đã hết hạn. Hãy chọn lại tệp.",
};
type Entry = { key: string; name: string; size: number; fileId: string | null; status: "uploading" | "scanning" | "clean" | "rejected" | "failed"; progress: number; message: string | null };
const sizeText = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
// Match the server display policy without importing its Node storage dependencies.
function displayName(value: string): string {
  let name = value.normalize("NFC").replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/[\\/]/gu, "_").replace(/\s+/gu, " ").trim().replace(/^\.+/u, "").trim();
  while (new TextEncoder().encode(name).byteLength > 255) name = [...name].slice(0, -1).join("");
  return name.trim() || "Tệp tham khảo";
}

function putWithProgress(url: string, file: File, headers: Record<string, string>, signal: AbortSignal, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url); request.timeout = 120_000;
    // Browsers own Content-Length; File sends the exact declared byte count.
    for (const [name, value] of Object.entries(headers)) if (name.toLowerCase() !== "content-length") request.setRequestHeader(name, value);
    const abort = () => request.abort();
    signal.addEventListener("abort", abort, { once: true });
    request.onloadend = () => signal.removeEventListener("abort", abort);
    request.onabort = request.ontimeout = () => reject(new TipRequestError("storage_unavailable"));
    request.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.min(99, Math.floor((event.loaded / event.total) * 100))); };
    request.onload = () => request.status >= 200 && request.status < 300 ? resolve() : reject(new TipRequestError("storage_unavailable"));
    request.onerror = () => reject(new TipRequestError("storage_unavailable"));
    if (signal.aborted) { signal.removeEventListener("abort", abort); reject(new TipRequestError("storage_unavailable")); } else request.send(file);
  });
}

export function ReferenceFilePicker({ packageId, disabled, onChange }: Readonly<{ packageId: string; disabled: boolean; onChange: (value: { fileIds: string[]; ready: boolean }) => void }>) {
  const id = useId(); const verify = useCommissionSession(); const input = useRef<HTMLInputElement>(null);
  const [entries, setEntries] = useState<Entry[]>([]); const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true); const jobs = useRef(new Map<string, AbortController>()); const count = useRef(0);
  useEffect(() => { alive.current = true; const active = jobs.current; return () => { alive.current = false; for (const job of active.values()) job.abort(); active.clear(); }; }, []);
  const update = (key: string, patch: Partial<Entry>) => { if (alive.current) setEntries((current) => current.map((entry) => entry.key === key ? { ...entry, ...patch } : entry)); };
  useEffect(() => {
    onChange({ fileIds: entries.filter((entry) => entry.status === "clean" && entry.fileId).map((entry) => entry.fileId!), ready: entries.every((entry) => entry.status === "clean") });
  }, [entries, onChange]);

  async function poll(key: string, fileId: string, actorUserId: string, signal: AbortSignal) {
    for (let attempt = 0; alive.current && !signal.aborted && attempt < 400; attempt += 1) {
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, attempt < 10 ? 1_500 : 5_000); signal.addEventListener("abort", done, { once: true });
      });
      if (signal.aborted) return;
      try {
        const { file } = fileSchema.parse(await tipRequest(`/api/v1/commission-files/${fileId}`, { signal, headers: { "x-pawket-actor": actorUserId } }));
        if (file.state === "clean") { update(key, { status: "clean", message: null }); return; }
        if (["rejected", "scan_failed", "expired", "discarded"].includes(file.state)) { update(key, { status: "rejected", message: REJECTIONS[file.rejectionReason ?? file.state] ?? REJECTIONS.scan_failed! }); return; }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof TipRequestError && ["account_changed", "authentication_required", "not_available", "files_disabled", "OIDC_ACTOR_CHANGED"].includes(error.code)) throw error;
        // Temporary dependency failures can recover on the next bounded read.
      }
    }
    update(key, { status: "failed", message: "Chưa nhận được kết quả kiểm tra. Gỡ tệp và thử lại sau." });
  }
  async function upload(entry: Entry, file: File) {
    const controller = new AbortController(); jobs.current.set(entry.key, controller); const signal = controller.signal;
    try {
      const actorUserId = await verify(true);
      if (signal.aborted) return;
      const json = { "content-type": "application/json", "x-pawket-actor": actorUserId };
      const { upload: grant } = grantSchema.parse(await tipRequest("/api/v1/commission-files", { signal, method: "POST", headers: { ...json, "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ context: "brief", packageId, fileName: file.name, declaredBytes: file.size }) }));
      update(entry.key, { fileId: grant.fileId });
      if (signal.aborted) return;
      await putWithProgress(grant.url, file, grant.requiredHeaders, signal, (progress) => update(entry.key, { progress }));
      if (signal.aborted) return;
      await tipRequest(`/api/v1/commission-files/${grant.fileId}/complete`, { signal, method: "POST", headers: json, body: "{}" });
      update(entry.key, { status: "scanning", progress: 100 });
      await poll(entry.key, grant.fileId, actorUserId, signal);
    } catch (error) {
      if (signal.aborted) return;
      update(entry.key, { status: "failed", message: commissionErrorText(error instanceof TipRequestError ? error.code : "dependency_unavailable") });
    } finally { jobs.current.delete(entry.key); }
  }
  function choose(list: FileList | null) {
    if (!list || disabled) return; setNotice(null);
    const files = [...list]; const room = MAX_FILES - count.current;
    if (files.length > room) setNotice(`Chỉ thêm được ${Math.max(0, room)} tệp nữa.`);
    const accepted = files.slice(0, Math.max(0, room));
    count.current += accepted.length;
    const added: Entry[] = accepted.map((file) => ({ key: crypto.randomUUID(), name: displayName(file.name), size: file.size, fileId: null, progress: 0,
      status: file.size > MAX_BYTES || file.size === 0 ? "rejected" : "uploading", message: file.size > MAX_BYTES ? "Tệp vượt quá 25 MB." : file.size === 0 ? "Tệp trống." : null }));
    setEntries((current) => [...current, ...added]);
    added.forEach((entry, index) => { if (entry.status === "uploading") void upload(entry, accepted[index]!); });
    if (input.current) input.current.value = "";
  }
  async function remove(entry: Entry) {
    jobs.current.get(entry.key)?.abort(); count.current -= 1;
    setEntries((current) => current.filter((item) => item.key !== entry.key));
    if (!entry.fileId) return;
    try { const actorUserId = await verify(true); await tipRequest(`/api/v1/commission-files/${entry.fileId}/discard`, { method: "POST", headers: { "content-type": "application/json", "x-pawket-actor": actorUserId }, body: "{}" }); }
    catch { /* unsent files are discarded automatically after 24 hours */ }
  }
  return <Field data-disabled={disabled || undefined}>
    <FieldLabel htmlFor={`${id}-files`}>Tệp tham khảo (không bắt buộc)</FieldLabel>
    <Input ref={input} id={`${id}-files`} type="file" multiple accept={ACCEPT} disabled={disabled || entries.length >= MAX_FILES} aria-describedby={`${id}-files-help`}
      onChange={(event) => choose(event.currentTarget.files)} className="text-sm" />
    <FieldDescription id={`${id}-files-help`}>Tối đa 10 tệp JPEG, PNG, WebP, GIF hoặc PDF, mỗi tệp tối đa 25 MB. Tệp chỉ gửi được sau khi kiểm tra mã độc xong.</FieldDescription>
    {notice ? <p role="status" className="text-sm">{notice}</p> : null}
    {entries.length ? <ul className="flex flex-col gap-2" aria-live="polite">{entries.map((entry) => <li key={entry.key} className="flex flex-wrap items-center gap-2 text-sm">
      <span className="min-w-0 wrap-anywhere">{entry.name}</span><span className="text-muted-foreground">{sizeText(entry.size)}</span>
      <Badge className="h-auto max-w-full whitespace-normal wrap-anywhere text-left" variant={entry.status === "clean" ? "secondary" : entry.status === "rejected" || entry.status === "failed" ? "destructive" : "outline"}>
        {entry.status === "uploading" ? `Đang tải lên… ${entry.progress}%` : entry.status === "scanning" ? "Đang kiểm tra tệp…" : entry.status === "clean" ? "Đã kiểm tra, không phát hiện mã độc đã biết" : entry.status === "rejected" ? "Tệp bị từ chối" : "Chưa kiểm tra được"}
      </Badge>
      {entry.message ? <span role="alert" className="basis-full text-destructive">{entry.message}</span> : null}
      <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => void remove(entry)} aria-label={`Gỡ ${entry.name}`}>Gỡ</Button>
    </li>)}</ul> : null}
  </Field>;
}

export function ReferenceFileList({ order }: Readonly<{ order: OrderView["order"] }>) {
  if (!order.referenceFiles.length) return null;
  const base = `/api/v1${order.role === "creator" ? "/creator/commissions" : "/commissions"}/${order.id}/files`;
  return <div className="flex min-w-0 flex-col gap-3"><h3 className="text-sm font-medium">Tệp tham khảo</h3><ul className="flex min-w-0 flex-col gap-3">
    {order.referenceFiles.map((file) => <li key={file.fileId} className="flex min-w-0 flex-col gap-2 text-sm">
      {file.availability === "withdrawn" ? <p className="text-muted-foreground">Không còn quyền xem sau khi yêu cầu đóng.</p>
        : <>
          <div className="flex flex-wrap items-center gap-2"><span className="min-w-0 wrap-anywhere font-medium">{file.name}</span><span className="text-muted-foreground">{sizeText(file.sizeBytes)} · {file.detectedType.toUpperCase()}</span></div>
          {file.availability === "deleted" ? <p className="text-muted-foreground">Tệp đã được xóa theo thời hạn lưu trữ.</p> : <>
            {/* eslint-disable-next-line @next/next/no-img-element -- private presigned preview; next/image would proxy and cache it */}
            {file.previewable ? <img src={`${base}/${file.fileId}?disposition=inline`} alt={`Xem trước ${file.name}`} loading="lazy" referrerPolicy="no-referrer" className="max-h-64 w-auto max-w-full rounded-md border object-contain" /> : null}
            <a href={`${base}/${file.fileId}?disposition=attachment`} rel="noopener noreferrer" referrerPolicy="no-referrer" className={buttonVariants({ variant: "outline", size: "sm" })}>Tải xuống</a>
          </>}
          <details><summary className="cursor-pointer text-muted-foreground">Mã kiểm tra SHA-256</summary><code className="break-all text-xs">{file.sha256.slice("sha256:".length)}</code></details>
        </>}
    </li>)}
  </ul></div>;
}
