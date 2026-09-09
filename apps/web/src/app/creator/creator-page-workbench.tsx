"use client";

import Link from "next/link";
import { useRef, useState } from "react";

import { Field } from "../../ui/field";
import { FormErrorSummary, type FieldError } from "../../ui/form-error-summary";
import { StatusBanner } from "../../ui/status-banner";

type Draft = Readonly<{
  displayName: string;
  introduction: string;
  primaryDiscipline: string;
  secondaryDisciplines: readonly string[];
  avatarAssetId: string | null;
  coverAssetId: string | null;
}>;
type MediaReference = Readonly<{ assetId: string; alternativeText: string; position: number }>;
type Showcase = Readonly<{
  id: string;
  position: number;
  title: string;
  description: string;
  discipline: string;
  contentLabel: "general_audience";
  externalUrl: string | null;
  media: readonly MediaReference[];
}>;
type MediaState = Readonly<{
  assetId: string;
  purpose: "avatar" | "cover" | "showcase";
  state: "awaiting_upload" | "pending" | "processing" | "ready" | "failed";
  derivatives: Partial<Record<"thumb" | "display" | "large", Readonly<{ derivativeId: string; width: number; height: number }>>>;
}>;
type Workspace = Readonly<{
  pageId: string;
  draftVersion: number;
  publishedRevisionId: string | null;
  canonicalHandle: string | null;
  aliases: readonly string[];
  renameAvailableAt: Date | string | null;
  draft: Draft;
  showcases: readonly Showcase[];
  media: readonly MediaState[];
  capabilityState: "active" | "suspended";
  enforcement: Readonly<{ pageHeld: boolean; heldShowcaseIds: readonly string[] }>;
}>;
type NewShowcase = Readonly<{ title: string; description: string; discipline: string; externalUrl: string }>;

const disciplines = ["illustration", "drawing", "painting", "comics", "animation", "three_d", "graphic_design", "photography", "crafts", "other"];
const responseMessages: Record<string, string> = {
  HANDLE_UNAVAILABLE: "Handle này không khả dụng. Hãy chọn một handle khác.",
  RENAME_COOLDOWN: "Bạn chỉ có thể đổi handle sau khi thời gian chờ kết thúc.",
  IDEMPOTENCY_CONFLICT: "Yêu cầu này không khớp với thao tác trước đó. Hãy thử lại bằng thao tác mới.",
  RECENT_AUTH_REQUIRED: "Hãy đăng nhập lại trước khi đổi handle.",
  POLICY_VIOLATION: "Nội dung chưa đáp ứng chính sách xuất bản. Hãy kiểm tra các trường và media.",
  NOT_FOUND: "Thao tác này không khả dụng với trạng thái creator hiện tại.",
};

async function json(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function submitVersionedCommand(path: string, body: unknown, version: number) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
      "If-Match": String(version),
    },
    body: JSON.stringify(body),
  });
  const value = await json(response);
  if (response.status === 409 && value.code === "VERSION_CONFLICT") return { kind: "conflict" as const };
  if (!response.ok) return { kind: "error" as const, code: typeof value.code === "string" ? value.code : "CATALOG_UNAVAILABLE" };
  return { kind: "saved" as const };
}

function workspaceSnapshot(value: unknown): Workspace | null {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as { workspace?: unknown }).workspace;
  if (!candidate || typeof candidate !== "object") return null;
  const projected = candidate as Omit<Workspace, "capabilityState" | "enforcement"> & {
    status?: Readonly<{ capabilityState?: "active" | "suspended"; pageHeld?: boolean; heldShowcaseIds?: readonly string[] }>;
  };
  if (
    !projected.status ||
    (projected.status.capabilityState !== "active" && projected.status.capabilityState !== "suspended") ||
    typeof projected.status.pageHeld !== "boolean" ||
    !Array.isArray(projected.status.heldShowcaseIds) ||
    !Array.isArray(projected.media)
  ) return null;
  return {
    ...projected,
    capabilityState: projected.status.capabilityState,
    enforcement: { pageHeld: projected.status.pageHeld, heldShowcaseIds: projected.status.heldShowcaseIds },
  };
}

function sourceFormat(file: File): "jpeg" | "png" | "webp" | null {
  if (file.type === "image/jpeg") return "jpeg";
  if (file.type === "image/png") return "png";
  if (file.type === "image/webp") return "webp";
  return null;
}

function mergeLocalInputs(authoritative: readonly Showcase[], local: readonly Showcase[]): readonly Showcase[] {
  return authoritative.map((serverShowcase) => {
    const localShowcase = local.find((item) => item.id === serverShowcase.id);
    if (!localShowcase) return serverShowcase;
    return {
      ...serverShowcase,
      title: localShowcase.title,
      description: localShowcase.description,
      discipline: localShowcase.discipline,
      externalUrl: localShowcase.externalUrl,
      media: serverShowcase.media.map((serverMedia) => ({
        ...serverMedia,
        alternativeText: localShowcase.media.find((item) => item.assetId === serverMedia.assetId)?.alternativeText ?? serverMedia.alternativeText,
      })),
    };
  });
}

export function CreatorPageWorkbench({ initialWorkspace }: Readonly<{ initialWorkspace: Workspace }>) {
  const [server, setServer] = useState(initialWorkspace);
  const [draft, setDraft] = useState<Draft>(initialWorkspace.draft);
  const [handle, setHandle] = useState(initialWorkspace.canonicalHandle ?? "");
  const [showcases, setShowcases] = useState<readonly Showcase[]>(initialWorkspace.showcases);
  const [newShowcase, setNewShowcase] = useState<NewShowcase>({ title: "", description: "", discipline: "illustration", externalUrl: "" });
  const [newAlt, setNewAlt] = useState<Record<string, string>>({});
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error" | "warning"; text: string } | null>(null);
  const [errors, setErrors] = useState<readonly FieldError[]>([]);
  const statusRef = useRef<HTMLDivElement>(null);

  async function readWorkspace() {
    const response = await fetch("/api/v1/creator-page", { cache: "no-store" });
    return workspaceSnapshot(await json(response));
  }

  function acceptWorkspace(current: Workspace) {
    setServer(current);
    setShowcases((local) => mergeLocalInputs(current.showcases, local));
  }

  async function handleConflict() {
    const current = await readWorkspace();
    if (current) acceptWorkspace(current);
    setNotice({
      tone: "warning",
      text: "Bản nháp trên máy chủ đã thay đổi. Pawket đã tải phiên bản và thứ tự hiện tại nhưng giữ nguyên nội dung bạn đang nhập; hãy rà soát rồi gửi lại.",
    });
  }

  async function run(path: string, body: unknown, success: string) {
    setWorking(true);
    setErrors([]);
    setNotice(null);
    try {
      const result = await submitVersionedCommand(path, body, server.draftVersion);
      if (result.kind === "conflict") {
        await handleConflict();
        return false;
      }
      if (result.kind === "error") {
        setErrors([{ fieldId: "creator-workbench", message: responseMessages[result.code] ?? "Không thể lưu thay đổi. Hãy kiểm tra dữ liệu và thử lại." }]);
        return false;
      }
      const current = await readWorkspace();
      if (current) acceptWorkspace(current);
      setNotice({ tone: "success", text: success });
      return true;
    } catch {
      setErrors([{ fieldId: "creator-workbench", message: "Kết nối bị gián đoạn. Chưa có thay đổi nào được xác nhận." }]);
      return false;
    } finally {
      setWorking(false);
      statusRef.current?.focus();
    }
  }

  function showcaseInput(showcase: Showcase, media = showcase.media) {
    return {
      id: showcase.id,
      position: showcase.position,
      title: showcase.title,
      description: showcase.description,
      discipline: showcase.discipline,
      contentLabel: "general_audience",
      externalUrl: showcase.externalUrl,
      media: media.map(({ assetId, alternativeText }) => ({ assetId, alternativeText })),
    };
  }

  async function upload(file: File, purpose: "avatar" | "cover" | "showcase", showcase?: Showcase) {
    const format = sourceFormat(file);
    if (!format) {
      setErrors([{ fieldId: "creator-workbench", message: "Chỉ chấp nhận ảnh JPEG, PNG hoặc WebP." }]);
      return;
    }
    setWorking(true);
    setErrors([]);
    setNotice(null);
    try {
      const issuedResponse = await fetch("/api/v1/creator-page/media/uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ purpose, declaredSourceFormat: format, contentType: file.type, declaredBytes: file.size }),
      });
      const issuedBody = await json(issuedResponse);
      const issued = issuedBody.result as { assetId: string; intentId: string; url: string; requiredHeaders: Record<string, string> } | undefined;
      if (!issuedResponse.ok || !issued) throw new Error();

      const nextDraft = purpose === "avatar"
        ? { ...draft, avatarAssetId: issued.assetId }
        : purpose === "cover"
          ? { ...draft, coverAssetId: issued.assetId }
          : draft;
      const attached = showcase
        ? await submitVersionedCommand("/api/v1/creator-page/showcases", {
          pageId: server.pageId,
          action: "update",
          showcase: showcaseInput(showcase, [
            ...showcase.media,
            { assetId: issued.assetId, alternativeText: newAlt[showcase.id] ?? "", position: showcase.media.length },
          ]),
        }, server.draftVersion)
        : await submitVersionedCommand("/api/v1/creator-page", { pageId: server.pageId, draft: nextDraft }, server.draftVersion);
      if (attached.kind === "conflict") {
        await handleConflict();
        return;
      }
      if (attached.kind === "error") throw new Error(attached.code);
      const attachedWorkspace = await readWorkspace();
      if (!attachedWorkspace) throw new Error();
      acceptWorkspace(attachedWorkspace);
      setDraft(nextDraft);

      const uploaded = await fetch(issued.url, { method: "PUT", headers: issued.requiredHeaders, body: file });
      if (!uploaded.ok) throw new Error();
      const completed = await fetch(`/api/v1/creator-page/media/uploads/${issued.intentId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ assetId: issued.assetId }),
      });
      if (!completed.ok) throw new Error();

      for (let attempt = 0; attempt < 90; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        const current = await readWorkspace();
        const state = current?.media.find((item) => item.assetId === issued.assetId)?.state;
        if (current) acceptWorkspace(current);
        if (state === "ready") {
          setNewAlt((values) => showcase ? { ...values, [showcase.id]: "" } : values);
          setNotice({
            tone: "success",
            text: purpose === "avatar" ? "Ảnh đại diện đã sẵn sàng." : purpose === "cover" ? "Ảnh bìa đã sẵn sàng." : "Ảnh showcase đã sẵn sàng.",
          });
          return;
        }
        if (state === "failed") throw new Error();
      }
      throw new Error();
    } catch {
      setErrors([{ fieldId: "creator-workbench", message: "Chưa thể xử lý ảnh. Hãy thử lại với một tệp hợp lệ." }]);
    } finally {
      setWorking(false);
      statusRef.current?.focus();
    }
  }

  function updateShowcase(showcaseId: string, update: (showcase: Showcase) => Showcase) {
    setShowcases((items) => items.map((item) => item.id === showcaseId ? update(item) : item));
  }

  function move(showcaseId: string, offset: -1 | 1) {
    const current = [...showcases];
    const index = current.findIndex((item) => item.id === showcaseId);
    const next = index + offset;
    if (index < 0 || next < 0 || next >= current.length) return;
    [current[index], current[next]] = [current[next]!, current[index]!];
    setShowcases(current);
    void run("/api/v1/creator-page/showcases", {
      pageId: server.pageId,
      action: "reorder",
      showcaseIds: current.map((item) => item.id),
    }, "Đã cập nhật thứ tự tác phẩm.");
  }

  const active = server.capabilityState === "active";
  const mediaById = new Map(server.media.map((item) => [item.assetId, item]));

  return (
    <div id="creator-workbench" className="creator-workbench stack">
      <FormErrorSummary errors={errors} />
      <div ref={statusRef} className="creator-workbench__status" aria-live="polite" tabIndex={-1}>
        {working ? <p>Đang lưu và xử lý…</p> : notice ? <StatusBanner tone={notice.tone}><p>{notice.text}</p></StatusBanner> : null}
      </div>
      {!active ? <StatusBanner tone="warning"><p>Quyền creator đang tạm dừng. Bạn vẫn có thể sửa hoặc gỡ nội dung riêng tư và xử lý ảnh thay thế, nhưng không thể đổi handle hay xuất bản.</p></StatusBanner> : null}

      <div className="creator-workbench__columns">
        <section className="work-surface stack">
          <h2>Tên và chuyên ngành</h2>
          <form className="stack" onSubmit={(event) => {
            event.preventDefault();
            void run("/api/v1/creator-page", { pageId: server.pageId, draft }, "Đã lưu hồ sơ vào bản nháp riêng tư.");
          }}>
            <Field htmlFor="creator-display-name" label="Tên hiển thị" hint="Tên công khai, tối đa 80 ký tự." required>
              <input id="creator-display-name" value={draft.displayName} maxLength={80} required onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} />
            </Field>
            <Field htmlFor="creator-introduction" label="Giới thiệu" hint="Mô tả ngắn thực hành sáng tạo của bạn, tối đa 500 ký tự." required>
              <textarea id="creator-introduction" value={draft.introduction} maxLength={500} required onChange={(event) => setDraft({ ...draft, introduction: event.target.value })} />
            </Field>
            <Field htmlFor="creator-primary-discipline" label="Chuyên ngành chính" required>
              <select id="creator-primary-discipline" value={draft.primaryDiscipline} onChange={(event) => setDraft({ ...draft, primaryDiscipline: event.target.value, secondaryDisciplines: draft.secondaryDisciplines.filter((item) => item !== event.target.value) })}>
                {disciplines.map((item) => <option key={item}>{item}</option>)}
              </select>
            </Field>
            <fieldset className="choice-fieldset">
              <legend>Chuyên ngành phụ (tối đa 2)</legend>
              <div className="choice-grid">
                {disciplines.filter((item) => item !== draft.primaryDiscipline).map((item) => (
                  <label className="choice-row" key={item}>
                    <input
                      type="checkbox"
                      checked={draft.secondaryDisciplines.includes(item)}
                      disabled={!draft.secondaryDisciplines.includes(item) && draft.secondaryDisciplines.length >= 2}
                      onChange={(event) => setDraft({
                        ...draft,
                        secondaryDisciplines: event.target.checked ? [...draft.secondaryDisciplines, item] : draft.secondaryDisciplines.filter((value) => value !== item),
                      })}
                    />
                    {item}
                  </label>
                ))}
              </div>
            </fieldset>
            <button disabled={working}>Lưu hồ sơ nháp</button>
          </form>
        </section>

        <section className="work-surface stack">
          <h2>Handle công khai</h2>
          <form className="stack" onSubmit={(event) => {
            event.preventDefault();
            void run("/api/v1/creator-page/handle", { pageId: server.pageId, action: server.canonicalHandle ? "rename" : "claim", handle }, "Đã cập nhật địa chỉ trang.");
          }}>
            <Field htmlFor="creator-handle" label="Handle" hint="Chữ thường, số và dấu gạch ngang; từ 3 đến 30 ký tự." required>
              <input id="creator-handle" value={handle} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" minLength={3} maxLength={30} disabled={!active} required onChange={(event) => setHandle(event.target.value)} />
            </Field>
            <button className="secondary" disabled={working || !active}>{server.canonicalHandle ? "Đổi handle" : "Nhận handle"}</button>
          </form>
          {server.aliases.length > 0 ? <p className="muted">Alias đang chuyển hướng: {server.aliases.join(", ")}</p> : null}
        </section>
      </div>

      <section className="work-surface stack">
        <div><h2>Ảnh đại diện và ảnh bìa</h2><p className="muted">Ảnh đại diện dùng tên hiển thị làm mô tả thay thế; ảnh bìa là trang trí. Chỉ ảnh xử lý xong mới có thể xuất bản.</p></div>
        <div className="media-control-grid">
          {(["avatar", "cover"] as const).map((purpose) => {
            const assetId = purpose === "avatar" ? draft.avatarAssetId : draft.coverAssetId;
            const label = purpose === "avatar" ? "ảnh đại diện" : "ảnh bìa";
            return (
              <div className="media-control stack" key={purpose}>
                <label>
                  {purpose === "avatar" ? "Tải ảnh đại diện" : "Tải ảnh bìa"}
                  <input type="file" accept="image/jpeg,image/png,image/webp" disabled={working} onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void upload(file, purpose);
                  }} />
                </label>
                <p aria-live="polite">{assetId ? `${label}: ${mediaById.get(assetId)?.state ?? "đang chờ"}` : `${label}: chưa chọn`}</p>
                {assetId ? <button type="button" className="quiet" disabled={working} onClick={() => {
                  const nextDraft = { ...draft, [purpose === "avatar" ? "avatarAssetId" : "coverAssetId"]: null };
                  setDraft(nextDraft);
                  void run("/api/v1/creator-page", { pageId: server.pageId, draft: nextDraft }, `Đã gỡ ${label}.`);
                }}>Gỡ {label}</button> : null}
              </div>
            );
          })}
        </div>
      </section>

      <section className="work-surface stack">
        <div><h2>Showcase theo thứ tự</h2><p className="muted">Tối đa 12 showcase và 4 ảnh mỗi showcase. Mọi ảnh cần mô tả thay thế do bạn viết.</p></div>
        <form className="stack" onSubmit={(event) => {
          event.preventDefault();
          void run("/api/v1/creator-page/showcases", {
            pageId: server.pageId,
            action: "create",
            showcase: {
              position: showcases.length,
              title: newShowcase.title,
              description: newShowcase.description,
              discipline: newShowcase.discipline,
              contentLabel: "general_audience",
              externalUrl: newShowcase.externalUrl || null,
              media: [],
            },
          }, "Đã tạo showcase.").then((saved) => {
            if (saved) setNewShowcase({ title: "", description: "", discipline: "illustration", externalUrl: "" });
          });
        }}>
          <Field htmlFor="new-showcase-title" label="Tên showcase" required><input id="new-showcase-title" value={newShowcase.title} maxLength={100} required onChange={(event) => setNewShowcase({ ...newShowcase, title: event.target.value })} /></Field>
          <Field htmlFor="new-showcase-description" label="Mô tả showcase"><textarea id="new-showcase-description" value={newShowcase.description} maxLength={1000} onChange={(event) => setNewShowcase({ ...newShowcase, description: event.target.value })} /></Field>
          <Field htmlFor="new-showcase-discipline" label="Chuyên ngành showcase" required><select id="new-showcase-discipline" value={newShowcase.discipline} onChange={(event) => setNewShowcase({ ...newShowcase, discipline: event.target.value })}>{disciplines.map((item) => <option key={item}>{item}</option>)}</select></Field>
          <Field htmlFor="new-showcase-url" label="Liên kết tác phẩm" hint="Không bắt buộc; chỉ dùng HTTPS."><input id="new-showcase-url" type="url" pattern="https://.*" value={newShowcase.externalUrl} onChange={(event) => setNewShowcase({ ...newShowcase, externalUrl: event.target.value })} /></Field>
          <button disabled={working || showcases.length >= 12}>Tạo showcase</button>
        </form>

        <ol className="showcase-editor">
          {showcases.map((showcase, index) => (
            <li key={showcase.id}>
              <article className="showcase-editor__item">
                <div className="stack">
                  <Field htmlFor={`showcase-title-${showcase.id}`} label="Tên showcase đã lưu" required><input id={`showcase-title-${showcase.id}`} value={showcase.title} maxLength={100} required onChange={(event) => updateShowcase(showcase.id, (item) => ({ ...item, title: event.target.value }))} /></Field>
                  <Field htmlFor={`showcase-description-${showcase.id}`} label="Mô tả showcase đã lưu"><textarea id={`showcase-description-${showcase.id}`} value={showcase.description} maxLength={1000} onChange={(event) => updateShowcase(showcase.id, (item) => ({ ...item, description: event.target.value }))} /></Field>
                  <Field htmlFor={`showcase-discipline-${showcase.id}`} label="Chuyên ngành showcase đã lưu" required><select id={`showcase-discipline-${showcase.id}`} value={showcase.discipline} onChange={(event) => updateShowcase(showcase.id, (item) => ({ ...item, discipline: event.target.value }))}>{disciplines.map((item) => <option key={item}>{item}</option>)}</select></Field>
                  <Field htmlFor={`showcase-url-${showcase.id}`} label="Liên kết tác phẩm đã lưu" hint="Không bắt buộc; chỉ dùng HTTPS."><input id={`showcase-url-${showcase.id}`} type="url" pattern="https://.*" value={showcase.externalUrl ?? ""} onChange={(event) => updateShowcase(showcase.id, (item) => ({ ...item, externalUrl: event.target.value || null }))} /></Field>
                  {showcase.media.map((reference) => (
                    <div className="showcase-media-editor stack" key={reference.assetId}>
                      <Field htmlFor={`showcase-alt-${reference.assetId}`} label="Mô tả thay thế" required>
                        <input id={`showcase-alt-${reference.assetId}`} value={reference.alternativeText} maxLength={300} required onChange={(event) => updateShowcase(showcase.id, (item) => ({ ...item, media: item.media.map((media) => media.assetId === reference.assetId ? { ...media, alternativeText: event.target.value } : media) }))} />
                      </Field>
                      <p className="muted">Trạng thái ảnh: {mediaById.get(reference.assetId)?.state ?? "đang chờ"}</p>
                      <button type="button" className="quiet" disabled={working} onClick={() => void run("/api/v1/creator-page/showcases", {
                        pageId: server.pageId,
                        action: "update",
                        showcase: showcaseInput(showcase, showcase.media.filter((item) => item.assetId !== reference.assetId)),
                      }, "Đã gỡ ảnh khỏi showcase.")}>Gỡ ảnh khỏi showcase</button>
                    </div>
                  ))}
                </div>
                <div className="stack">
                  <Field htmlFor={`showcase-new-alt-${showcase.id}`} label="Mô tả thay thế cho ảnh mới" required>
                    <input id={`showcase-new-alt-${showcase.id}`} value={newAlt[showcase.id] ?? ""} maxLength={300} onChange={(event) => setNewAlt({ ...newAlt, [showcase.id]: event.target.value })} />
                  </Field>
                  <label>
                    Thêm ảnh showcase
                    <input type="file" disabled={working || showcase.media.length >= 4 || !(newAlt[showcase.id] ?? "").trim()} accept="image/jpeg,image/png,image/webp" onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void upload(file, "showcase", showcase);
                    }} />
                  </label>
                  <div className="button-row">
                    <button type="button" className="secondary" disabled={working} onClick={() => void run("/api/v1/creator-page/showcases", { pageId: server.pageId, action: "update", showcase: showcaseInput(showcase) }, "Đã lưu showcase.")}>Lưu showcase</button>
                    <button type="button" className="quiet" disabled={working} onClick={() => void run("/api/v1/creator-page/showcases", { pageId: server.pageId, action: "remove", showcaseId: showcase.id }, "Đã gỡ showcase.")}>Gỡ showcase</button>
                    <button type="button" className="quiet showcase-editor__move" disabled={working || index === 0} onClick={() => move(showcase.id, -1)}>Di chuyển lên</button>
                    <button type="button" className="quiet showcase-editor__move" disabled={working || index === showcases.length - 1} onClick={() => move(showcase.id, 1)}>Di chuyển xuống</button>
                  </div>
                </div>
              </article>
            </li>
          ))}
        </ol>
      </section>

      <section className="work-surface stack">
        <div><h2>Bản nháp và trang đang live</h2><p className="muted">Lưu bản nháp không thay đổi trang công khai. Xuất bản tạo một revision bất biến mới.</p></div>
        <div className="creator-workbench__actions">
          <Link className="button-link secondary" href="/creator/preview">Xem bản nháp riêng tư</Link>
          <button type="button" disabled={working || !active || server.enforcement.pageHeld} onClick={() => void run("/api/v1/creator-page/publish", { pageId: server.pageId }, "Trang đã được xuất bản.")}>Xuất bản trang</button>
          {server.publishedRevisionId ? <button type="button" className="secondary" disabled={working || !active} onClick={() => void run("/api/v1/creator-page/unpublish", { pageId: server.pageId }, "Trang đã được gỡ khỏi công khai.")}>Gỡ xuất bản</button> : null}
        </div>
        {server.enforcement.pageHeld || server.enforcement.heldShowcaseIds.length > 0 ? <StatusBanner tone="warning"><p>Một phần nội dung đang bị owner ẩn. Trạng thái kiểm duyệt được giới hạn và không hiển thị dữ liệu báo cáo riêng tư.</p></StatusBanner> : null}
      </section>
    </div>
  );
}
