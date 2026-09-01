"use client";

import Link from "next/link";
import { type FormEvent, useRef, useState } from "react";

import { Field } from "../../ui/field";
import { FormErrorSummary, type FieldError } from "../../ui/form-error-summary";
import { StatusBanner } from "../../ui/status-banner";

type Draft = Readonly<{ displayName: string; introduction: string; primaryDiscipline: string; secondaryDisciplines: readonly string[]; avatarAssetId: string | null; coverAssetId: string | null }>;
type Media = Readonly<{ assetId: string; alternativeText: string; position: number }>;
type Showcase = Readonly<{ id: string; position: number; title: string; description: string; discipline: string; contentLabel: "general_audience"; externalUrl: string | null; media: readonly Media[] }>;
type Workspace = Readonly<{ pageId: string; draftVersion: number; publishedRevisionId: string | null; canonicalHandle: string | null; aliases: readonly string[]; renameAvailableAt: Date | string | null; draft: Draft; showcases: readonly Showcase[]; capabilityState: "active" | "suspended"; enforcement: Readonly<{ pageHeld: boolean; heldShowcaseIds: readonly string[] }> }>;

const disciplines = ["illustration", "drawing", "painting", "comics", "animation", "three_d", "graphic_design", "photography", "crafts", "other"];

async function json(response: Response): Promise<Record<string, unknown>> {
  try { return await response.json() as Record<string, unknown>; } catch { return {}; }
}

async function submitVersionedCommand(path: string, body: unknown, version: number) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID(), "If-Match": String(version) }, body: JSON.stringify(body) });
  if (response.status === 409) return { kind: "conflict" as const, current: await json(response) };
  if (!response.ok) return { kind: "error" as const, problem: await json(response) };
  return { kind: "saved" as const, value: await json(response) };
}

function workspaceSnapshot(value: unknown): Workspace | null {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as { workspace?: unknown }).workspace;
  if (!candidate || typeof candidate !== "object") return null;
  const projected = candidate as Omit<Workspace, "capabilityState" | "enforcement"> & {
    status?: Readonly<{ capabilityState?: "active" | "suspended"; pageHeld?: boolean; heldShowcaseIds?: readonly string[] }>;
  };
  if (!projected.status || (projected.status.capabilityState !== "active" && projected.status.capabilityState !== "suspended") || typeof projected.status.pageHeld !== "boolean" || !Array.isArray(projected.status.heldShowcaseIds)) return null;
  return {
    ...projected,
    capabilityState: projected.status.capabilityState,
    enforcement: { pageHeld: projected.status.pageHeld, heldShowcaseIds: projected.status.heldShowcaseIds },
  };
}

export function CreatorPageWorkbench({ initialWorkspace }: Readonly<{ initialWorkspace: Workspace }>) {
  const [server, setServer] = useState(initialWorkspace);
  const [draft, setDraft] = useState<Draft>(initialWorkspace.draft);
  const [handle, setHandle] = useState(initialWorkspace.canonicalHandle ?? "");
  const [showcases, setShowcases] = useState<readonly Showcase[]>(initialWorkspace.showcases);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error" | "warning"; text: string } | null>(null);
  const [errors, setErrors] = useState<readonly FieldError[]>([]);
  const statusRef = useRef<HTMLDivElement>(null);

  async function reloadAfterConflict() {
    const response = await fetch("/api/v1/creator-page", { cache: "no-store" });
    const current = workspaceSnapshot(await json(response));
    if (current) setServer(current);
    setNotice({ tone: "warning", text: "Bản nháp trên máy chủ đã thay đổi. Pawket đã tải phiên bản hiện tại nhưng giữ nguyên nội dung bạn đang nhập; hãy rà soát rồi gửi lại." });
  }

  async function run(path: string, body: unknown, success: string) {
    setWorking(true); setErrors([]); setNotice(null);
    try {
      const result = await submitVersionedCommand(path, body, server.draftVersion);
      if (result.kind === "conflict") { await reloadAfterConflict(); return; }
      if (result.kind === "error") { setErrors([{ fieldId: "creator-workbench", message: "Không thể lưu thay đổi. Hãy kiểm tra dữ liệu và thử lại." }]); return; }
      const refreshed = await fetch("/api/v1/creator-page", { cache: "no-store" });
      const current = workspaceSnapshot(await json(refreshed));
      if (current) { setServer(current); setShowcases(current.showcases); }
      setNotice({ tone: "success", text: success });
    } catch { setErrors([{ fieldId: "creator-workbench", message: "Kết nối bị gián đoạn. Chưa có thay đổi nào được xác nhận." }]); }
    finally { setWorking(false); statusRef.current?.focus(); }
  }

  function saveProfile(event: FormEvent<HTMLFormElement>) { event.preventDefault(); return run("/api/v1/creator-page", { pageId: server.pageId, draft }, "Đã lưu hồ sơ vào bản nháp riêng tư."); }
  function saveHandle(event: FormEvent<HTMLFormElement>) { event.preventDefault(); return run("/api/v1/creator-page/handle", { pageId: server.pageId, action: server.canonicalHandle ? "rename" : "claim", handle }, "Đã cập nhật địa chỉ trang."); }
  function move(showcaseId: string, offset: -1 | 1) {
    const current = [...showcases]; const index = current.findIndex((item) => item.id === showcaseId); const next = index + offset;
    if (index < 0 || next < 0 || next >= current.length) return;
    [current[index], current[next]] = [current[next]!, current[index]!];
    void run("/api/v1/creator-page/showcases", { pageId: server.pageId, action: "reorder", showcaseIds: current.map((item) => item.id) }, "Đã cập nhật thứ tự tác phẩm.");
  }

  return <div id="creator-workbench" className="creator-workbench stack">
    <FormErrorSummary errors={errors} />
    <div ref={statusRef} className="creator-workbench__status" aria-live="polite" tabIndex={-1}>{working ? <p>Đang lưu…</p> : notice ? <StatusBanner tone={notice.tone}><p>{notice.text}</p></StatusBanner> : null}</div>
    <div className="creator-workbench__columns">
      <section className="work-surface stack"><div><p className="eyebrow">Hồ sơ</p><h2>Tên và chuyên ngành</h2></div><form className="stack" onSubmit={saveProfile}>
        <Field htmlFor="creator-display-name" label="Tên hiển thị" hint="Tên công khai, tối đa 80 ký tự." required><input id="creator-display-name" value={draft.displayName} maxLength={80} required onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></Field>
        <Field htmlFor="creator-introduction" label="Giới thiệu" hint="Mô tả ngắn thực hành sáng tạo của bạn." required><textarea id="creator-introduction" value={draft.introduction} maxLength={500} required onChange={(event) => setDraft({ ...draft, introduction: event.target.value })} /></Field>
        <Field htmlFor="creator-primary-discipline" label="Chuyên ngành chính" required><select id="creator-primary-discipline" value={draft.primaryDiscipline} onChange={(event) => setDraft({ ...draft, primaryDiscipline: event.target.value, secondaryDisciplines: draft.secondaryDisciplines.filter((item) => item !== event.target.value) })}>{disciplines.map((item) => <option key={item} value={item}>{item}</option>)}</select></Field>
        <button disabled={working}>Lưu hồ sơ nháp</button></form></section>
      <section className="work-surface stack"><div><p className="eyebrow">Địa chỉ</p><h2>Handle công khai</h2></div><form className="stack" onSubmit={saveHandle}>
        <Field htmlFor="creator-handle" label="Handle" hint="Chữ thường, số và dấu gạch ngang; từ 3 đến 30 ký tự." required><input id="creator-handle" value={handle} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" minLength={3} maxLength={30} required onChange={(event) => setHandle(event.target.value)} /></Field>
        <button className="secondary" disabled={working}>{server.canonicalHandle ? "Đổi handle" : "Nhận handle"}</button></form>{server.aliases.length > 0 ? <p className="muted">Alias đang chuyển hướng: {server.aliases.join(", ")}</p> : null}</section>
    </div>
    <section className="work-surface stack"><div><p className="eyebrow">Media</p><h2>Ảnh đại diện và ảnh bìa</h2><p className="muted">Tải ảnh bằng luồng media riêng tư; chỉ asset đã xử lý xong mới có thể xuất bản.</p></div><div className="media-status-list" aria-live="polite"><p>Ảnh đại diện: {draft.avatarAssetId ? "Đã chọn asset" : "Chưa chọn"}</p><p>Ảnh bìa: {draft.coverAssetId ? "Đã chọn asset" : "Chưa chọn"}</p></div></section>
    <section className="work-surface stack"><div><p className="eyebrow">Tác phẩm</p><h2>Showcase theo thứ tự</h2><p className="muted">Dùng các nút di chuyển bằng bàn phím làm thao tác cơ bản. Mỗi ảnh showcase phải có mô tả thay thế do creator viết.</p></div><ol className="showcase-editor">{showcases.map((showcase, index) => <li key={showcase.id} className="showcase-editor__item"><div><strong>{showcase.title}</strong><p>{showcase.description}</p>{showcase.media.map((media) => <small key={media.assetId}>Alt: {media.alternativeText}</small>)}</div><div className="button-row"><button type="button" className="quiet showcase-editor__move" disabled={working || index === 0} onClick={() => move(showcase.id, -1)}>Di chuyển lên</button><button type="button" className="quiet showcase-editor__move" disabled={working || index === showcases.length - 1} onClick={() => move(showcase.id, 1)}>Di chuyển xuống</button></div></li>)}</ol></section>
    <section className="work-surface stack publication-preview"><div><p className="eyebrow">Ranh giới xuất bản</p><h2>Bản nháp và trang đang live</h2><p className="muted">Lưu bản nháp không thay đổi trang công khai. Xuất bản tạo một revision bất biến mới.</p></div><div className="creator-workbench__actions"><Link className="button-link secondary" href="/creator/preview">Xem bản nháp riêng tư</Link><button type="button" disabled={working || server.capabilityState !== "active" || server.enforcement.pageHeld} onClick={() => void run("/api/v1/creator-page/publish", { pageId: server.pageId }, "Trang đã được xuất bản.")}>Xuất bản trang</button>{server.publishedRevisionId ? <button type="button" className="secondary" disabled={working} onClick={() => void run("/api/v1/creator-page/unpublish", { pageId: server.pageId }, "Trang đã được gỡ khỏi công khai.")}>Gỡ xuất bản</button> : null}</div>
      {server.capabilityState === "suspended" ? <StatusBanner tone="warning"><p>Quyền creator đang tạm dừng. Việc khôi phục quyền không tự xuất bản lại trang.</p></StatusBanner> : null}{server.enforcement.pageHeld || server.enforcement.heldShowcaseIds.length > 0 ? <StatusBanner tone="warning"><p>Một phần nội dung đang bị owner ẩn. Trạng thái kiểm duyệt được giới hạn và không hiển thị dữ liệu báo cáo riêng tư.</p></StatusBanner> : null}</section>
  </div>;
}
