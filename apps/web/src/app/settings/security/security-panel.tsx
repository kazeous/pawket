"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";

import { EmptyState, LoadingState } from "../../../ui/async-state";
import { Field } from "../../../ui/field";
import { StatusBanner, StatusTag } from "../../../ui/status-banner";
import { groupedTotpSecret, totpSecretFromURI } from "./totp-enrollment";

type Account = { id: string; providerId: string };
type Session = { id: string; deviceLabel: string; createdAt: string; lastUsedAt: string };

async function requestJson(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(path, { credentials: "include", ...init });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof payload.code === "string" ? payload.code : "SECURITY_ACTION_FAILED");
  return payload;
}

const jsonPost = (body: Record<string, unknown>): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function readableMessage(code: string): string {
  const messages: Record<string, string> = {
    SECURITY_STATE_UNAVAILABLE: "Chưa tải được trạng thái bảo mật. Hãy thử tải lại trang.",
    SECURITY_ACTION_FAILED: "Chưa thể hoàn tất thao tác bảo mật. Hãy thử lại.",
    RECENT_AUTH_REQUIRED: "Phiên đăng nhập đã cũ. Hãy đăng xuất rồi đăng nhập lại trước khi đổi thông tin nhạy cảm.",
    CURRENT_PASSWORD_INVALID: "Mật khẩu hiện tại chưa đúng.",
    INVALID_PASSWORD: "Mật khẩu hiện tại chưa đúng.",
    POLICY_REJECTED: "Mật khẩu mới chưa đạt yêu cầu bảo mật.",
    EMAIL_UNAVAILABLE: "Email này không thể sử dụng.",
    SOCIAL_LINK_UNAVAILABLE: "Chưa thể bắt đầu liên kết tài khoản.",
    TOTP_ENROLLMENT_UNAVAILABLE: "Chưa thể bắt đầu thiết lập ứng dụng xác thực.",
    TOTP_ALREADY_ENABLED: "Xác thực 2 bước đã được bật. Pawket không thay khóa xác thực đang hoạt động.",
    RECENT_PRIMARY_AUTHENTICATION_REQUIRED: "Phiên xác thực gần đây đã hết hạn. Hãy đăng xuất rồi đăng nhập lại trước khi thay đổi bảo mật.",
    RECENT_TOTP_REQUIRED: "Hãy đăng xuất rồi đăng nhập lại bằng mã xác thực trước khi tạo bộ mã khôi phục mới.",
    SESSION_REVOCATION_FAILED: "Chưa thể thu hồi phiên này.",
  };
  return messages[code] ?? "Chưa thể hoàn tất thao tác. Hãy thử lại.";
}

export function AuthenticatorSetup({
  onCancel,
  onVerify,
  totpURI,
  working,
}: {
  onCancel(): void;
  onVerify(event: FormEvent<HTMLFormElement>): void;
  totpURI: string;
  working: boolean;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const secret = totpSecretFromURI(totpURI);

  async function copySecret() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopyState("copied");
      window.setTimeout(() => setCopyState((current) => current === "copied" ? "idle" : current), 2_500);
    } catch {
      setCopyState("error");
    }
  }

  if (!secret) {
    return <StatusBanner tone="error"><p>Mã thiết lập không hợp lệ. Hãy hủy và bắt đầu lại.</p><button type="button" className="secondary" disabled={working} onClick={onCancel}>Hủy thiết lập</button></StatusBanner>;
  }

  return (
    <div className="totp-enrollment stack">
      <div className="totp-setup-grid">
        <figure className="totp-qr">
          <QRCodeSVG
            aria-label="Mã QR để thêm Pawket vào ứng dụng xác thực"
            bgColor="var(--color-surface-strong)"
            fgColor="var(--color-ink)"
            level="M"
            marginSize={4}
            role="img"
            size={192}
            value={totpURI}
          />
          <figcaption>Quét mã bằng ứng dụng xác thực trên điện thoại.</figcaption>
        </figure>
        <div className="stack compact">
          <h3>Hoàn tất trên ứng dụng xác thực</h3>
          <ol className="totp-steps">
            <li>Quét mã QR để thêm tài khoản Pawket.</li>
            <li>Nhập mã 6 chữ số ứng dụng vừa tạo.</li>
            <li>Lưu mã khôi phục Pawket hiển thị sau khi xác minh.</li>
          </ol>
          <div className="totp-manual stack compact">
            <strong>Không quét được?</strong>
            <p className="muted">Nhập khóa này thủ công. Không gửi khóa cho người khác.</p>
            <div className="totp-manual-row">
              <code aria-label="Khóa thiết lập thủ công">{groupedTotpSecret(secret)}</code>
              <button type="button" className="secondary" disabled={working} onClick={copySecret}>
                {copyState === "copied" ? "Đã sao chép" : "Sao chép khóa"}
              </button>
            </div>
            <small className={copyState === "error" ? "field-error" : "muted"} aria-live="polite">
              {copyState === "copied"
                ? "Khóa đã được sao chép."
                : copyState === "error"
                  ? "Trình duyệt không thể sao chép. Hãy chọn và sao chép khóa thủ công."
                  : "Khoảng trắng chỉ giúp dễ đọc; ứng dụng xác thực có thể bỏ qua chúng."}
            </small>
          </div>
          <form onSubmit={onVerify} className="stack compact">
            <Field htmlFor="setup-code" label="Mã xác thực" hint="Nhập mã mới nhất từ ứng dụng xác thực." required>
              <input id="setup-code" name="code" inputMode="numeric" autoComplete="one-time-code" minLength={6} maxLength={8} required />
            </Field>
            <div className="button-row">
              <button type="submit" disabled={working}>Bật xác thực 2 bước</button>
              <button type="button" className="secondary" disabled={working} onClick={onCancel}>Hủy thiết lập</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

export function SecurityPanel({
  enabledProviders,
  initialMessage = null,
  initialTwoFactorEnabled,
}: {
  enabledProviders: readonly ("google" | "discord")[];
  initialMessage?: string | null;
  initialTwoFactorEnabled: boolean;
}) {
  const router = useRouter();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [totpURI, setTotpURI] = useState<string | null>(null);
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(initialTwoFactorEnabled);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(initialMessage);
  const [tone, setTone] = useState<"success" | "error" | "warning">("success");
  const [working, setWorking] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadSecurityState = useCallback(async () => {
    const [accountPayload, sessionPayload] = await Promise.all([requestJson("/api/auth/list-accounts"), requestJson("/api/v1/me/sessions")]);
    const rawAccounts = Array.isArray(accountPayload) ? accountPayload : accountPayload.accounts;
    setAccounts(Array.isArray(rawAccounts) ? rawAccounts.filter((account): account is Account => Boolean(account) && typeof account === "object" && typeof (account as Account).id === "string" && typeof (account as Account).providerId === "string") : []);
    setSessions(Array.isArray(sessionPayload.sessions) ? (sessionPayload.sessions as Session[]) : []);
    setLoading(false);
  }, []);

  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(() => { void loadSecurityState().catch(() => { if (current) { setTone("error"); setMessage(readableMessage("SECURITY_STATE_UNAVAILABLE")); setLoading(false); } }); }, 0);
    return () => { current = false; window.clearTimeout(timer); };
  }, [loadSecurityState]);

  async function run(action: () => Promise<void>) {
    setWorking(true); setMessage(null);
    try { await action(); } catch (error) { setTone("error"); setMessage(readableMessage(error instanceof Error ? error.message : "SECURITY_ACTION_FAILED")); } finally { setWorking(false); }
  }

  function linkProvider(provider: "google" | "discord") { return run(async () => { const payload = await requestJson("/api/auth/link-social", jsonPost({ provider, callbackURL: "/settings/security" })); if (typeof payload.url !== "string") throw new Error("SOCIAL_LINK_UNAVAILABLE"); window.location.assign(payload.url); }); }
  function unlinkAccount(accountId: string) { return run(async () => { await requestJson("/api/auth/unlink-account", jsonPost({ accountId })); await loadSecurityState(); setTone("success"); setMessage("Đã gỡ phương thức đăng nhập."); }); }

  function beginTotp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const element = event.currentTarget; const form = new FormData(element);
    return run(async () => { const password = form.get("password"); const payload = await requestJson("/api/auth/two-factor/enable", jsonPost({ method: "totp", ...(typeof password === "string" && password.length > 0 ? { password } : {}) })); if (typeof payload.totpURI !== "string") throw new Error("TOTP_ENROLLMENT_UNAVAILABLE"); element.reset(); setTotpURI(payload.totpURI); setTone("warning"); setMessage("Quét mã QR và nhập mã xác thực để hoàn tất. 2FA chưa được bật cho đến khi mã được xác minh."); });
  }

  function verifyTotp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    return run(async () => { const payload = await requestJson("/api/auth/two-factor/verify-totp", jsonPost({ code: form.get("code"), trustDevice: false })); setTotpURI(null); setTwoFactorEnabled(true); setRecoveryCodes(Array.isArray(payload.recoveryCodes) ? (payload.recoveryCodes as string[]) : []); setTone("success"); setMessage("Đã bật xác thực 2 bước. Hãy lưu bộ mã khôi phục trước khi rời trang."); });
  }

  function cancelTotp() {
    setTotpURI(null);
    setTone("warning");
    setMessage("Đã dừng thiết lập. Xác thực 2 bước vẫn chưa được bật.");
  }

  function regenerateRecoveryCodes() { return run(async () => { const payload = await requestJson("/api/auth/two-factor/regenerate-recovery-codes", jsonPost({})); setRecoveryCodes(Array.isArray(payload.recoveryCodes) ? (payload.recoveryCodes as string[]) : []); setTone("warning"); setMessage("Bộ mã khôi phục cũ đã mất hiệu lực."); }); }
  function revokeSession(sessionId: string) { return run(async () => { const response = await fetch(`/api/v1/me/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE", credentials: "include" }); if (!response.ok) throw new Error("SESSION_REVOCATION_FAILED"); await loadSecurityState(); }); }
  function revokeAllSessions() { return run(async () => { const response = await fetch("/api/v1/me/sessions", { method: "DELETE", credentials: "include" }); if (!response.ok) throw new Error("SESSION_REVOCATION_FAILED"); router.push("/sign-in"); }); }

  function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const element = event.currentTarget; const form = new FormData(element);
    return run(async () => { await requestJson("/api/v1/me/password", jsonPost({ currentPassword: form.get("currentPassword"), newPassword: form.get("newPassword") })); element.reset(); setTone("success"); setMessage("Đã đổi mật khẩu và thu hồi các phiên khác."); });
  }

  function requestEmailChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const element = event.currentTarget; const form = new FormData(element);
    return run(async () => { await requestJson("/api/v1/me/email-change/request", jsonPost({ newEmail: form.get("newEmail") })); element.reset(); setTone("success"); setMessage("Đã gửi liên kết xác nhận tới email mới."); });
  }

  return (
    <div className="security-workspace">
      <nav className="task-rail" aria-label="Các mục bảo mật"><a href="#methods">Phương thức</a><a href="#two-factor">Xác thực 2 bước</a><a href="#credentials">Email &amp; mật khẩu</a><a href="#sessions">Phiên đăng nhập</a></nav>
      <div className="stack">
        {message ? <StatusBanner tone={tone}><p>{message}</p></StatusBanner> : null}
        <section className="work-surface stack" id="methods">
          <div className="section-heading"><div><p className="eyebrow">01</p><h2>Phương thức đăng nhập</h2></div><StatusTag tone={accounts.length > 0 ? "success" : "warning"}>{accounts.length} phương thức</StatusTag></div>
          {loading ? <LoadingState label="Đang tải phương thức…" /> : <div className="stack compact">{accounts.map((account) => <div className="item-row" key={account.id}><strong>{account.providerId === "credential" ? "Email & mật khẩu" : account.providerId}</strong>{account.providerId === "google" || account.providerId === "discord" ? <button type="button" className="secondary" disabled={working} onClick={() => unlinkAccount(account.id)}>Gỡ</button> : null}</div>)}{enabledProviders.length > 0 ? <div className="button-row">{enabledProviders.includes("google") ? <button type="button" disabled={working} onClick={() => linkProvider("google")}>Liên kết Google</button> : null}{enabledProviders.includes("discord") ? <button type="button" disabled={working} onClick={() => linkProvider("discord")}>Liên kết Discord</button> : null}</div> : null}<small className="muted">Pawket luôn từ chối gỡ phương thức đăng nhập cuối cùng.</small></div>}
        </section>

        <section className="work-surface stack" id="two-factor">
          <div className="section-heading"><div><p className="eyebrow">02</p><h2>Ứng dụng xác thực</h2><p className="muted">Tạo mã dùng một lần trên điện thoại để bảo vệ bước đăng nhập thứ hai.</p></div><StatusTag tone={twoFactorEnabled ? "success" : "info"}>{twoFactorEnabled ? "Đang bật" : "Chưa bật"}</StatusTag></div>
          {twoFactorEnabled ? <div className="stack compact"><StatusBanner tone="success" title="Xác thực 2 bước đang bật"><p>Pawket sẽ yêu cầu mã từ ứng dụng xác thực sau bước đăng nhập chính.</p></StatusBanner><div className="stack compact"><button type="button" className="secondary" disabled={working} onClick={regenerateRecoveryCodes}>Tạo bộ mã khôi phục mới</button><small className="muted">Bộ mã hiện tại sẽ mất hiệu lực ngay sau khi bộ mới được tạo.</small></div></div> : totpURI ? <AuthenticatorSetup onCancel={cancelTotp} onVerify={verifyTotp} totpURI={totpURI} working={working} /> : <><StatusBanner title="Xác thực 2 bước chưa bật"><p>Thiết lập một lần bằng mã QR. Pawket sẽ giữ nguyên khóa sau khi bạn xác minh thành công.</p></StatusBanner><form onSubmit={beginTotp} className="stack compact"><Field htmlFor="totp-password" label="Mật khẩu hiện tại" hint="Chỉ cần nhập nếu tài khoản có mật khẩu."><input id="totp-password" name="password" type="password" autoComplete="current-password" /></Field><button type="submit" disabled={working}>Thiết lập ứng dụng xác thực</button></form></>}
          {recoveryCodes.length > 0 ? <div className="recovery-block" role="status"><strong>Lưu các mã này ngay. Pawket sẽ không hiển thị lại.</strong><ol>{recoveryCodes.map((code) => <li key={code}><code>{code}</code></li>)}</ol></div> : null}
        </section>

        <section className="work-surface stack" id="credentials">
          <div><p className="eyebrow">03</p><h2>Email &amp; mật khẩu</h2><p className="muted">Các thay đổi nhạy cảm cần một phiên đăng nhập gần đây.</p></div>
          <div className="settings-columns"><form className="stack compact" onSubmit={changePassword}><h3>Đổi mật khẩu</h3><Field htmlFor="current-password" label="Mật khẩu hiện tại" required><input id="current-password" name="currentPassword" type="password" autoComplete="current-password" required /></Field><Field htmlFor="new-password" label="Mật khẩu mới" hint="Từ 15 đến 128 ký tự." required><input id="new-password" name="newPassword" type="password" autoComplete="new-password" minLength={15} maxLength={128} required /></Field><button disabled={working}>Đổi mật khẩu</button></form><form className="stack compact" onSubmit={requestEmailChange}><h3>Đổi email</h3><Field htmlFor="new-email" label="Email mới" hint="Pawket sẽ gửi liên kết xác nhận tới địa chỉ này." required><input id="new-email" name="newEmail" type="email" autoComplete="email" required /></Field><button disabled={working}>Gửi liên kết xác nhận</button></form></div>
        </section>

        <section className="work-surface stack" id="sessions">
          <div className="section-heading"><div><p className="eyebrow">04</p><h2>Phiên đăng nhập</h2></div><StatusTag>{sessions.length} phiên</StatusTag></div>
          {!loading && sessions.length === 0 ? <EmptyState title="Không có phiên đang hoạt động"><p>Đăng nhập lại để tạo phiên mới.</p></EmptyState> : <div className="stack compact">{sessions.map((session) => <div className="item-row" key={session.id}><span><strong>{session.deviceLabel}</strong><small className="muted">Dùng gần nhất {new Date(session.lastUsedAt).toLocaleString("vi-VN")}</small></span><button type="button" className="secondary" disabled={working} onClick={() => revokeSession(session.id)}>Thu hồi</button></div>)}</div>}
          <div className="action-bar"><p>Đăng xuất khỏi tất cả thiết bị, bao gồm thiết bị này.</p><button type="button" className="danger" disabled={working} onClick={revokeAllSessions}>Thu hồi tất cả</button></div>
        </section>
      </div>
    </div>
  );
}
