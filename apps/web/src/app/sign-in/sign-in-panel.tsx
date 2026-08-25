"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import { AuthPanel } from "../../ui/auth-panel";
import { Field } from "../../ui/field";
import { StatusBanner } from "../../ui/status-banner";

type AuthPayload = Record<string, unknown>;

function authMessage(code: string): string {
  const messages: Record<string, string> = {
    AUTHENTICATION_FAILED: "Email hoặc mật khẩu chưa đúng.",
    SECOND_FACTOR_FAILED: "Mã xác minh chưa đúng hoặc đã hết hạn.",
    SOCIAL_SIGN_IN_UNAVAILABLE: "Đăng nhập qua nhà cung cấp này đang tạm gián đoạn.",
    account_not_linked: "Email này đã thuộc một tài khoản Pawket. Hãy đăng nhập bằng phương thức cũ rồi liên kết tài khoản trong phần Bảo mật.",
    email_not_found: "Nhà cung cấp chưa trả về email. Hãy bổ sung email ở nhà cung cấp rồi thử lại.",
    unable_to_create_user: "Pawket chưa thể chấp nhận danh tính này. Hãy kiểm tra email đã được xác minh.",
    account_already_linked_to_different_user: "Danh tính này đã được liên kết với tài khoản Pawket khác.",
    social: "Chưa thể hoàn tất đăng nhập mạng xã hội. Hãy thử lại.",
  };
  return messages[code] ?? "Chưa thể hoàn tất đăng nhập. Hãy kiểm tra thông tin và thử lại.";
}

async function postAuth(path: string, body: Record<string, unknown>): Promise<AuthPayload> {
  const response = await fetch(`/api/auth${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as AuthPayload;
  if (!response.ok) {
    throw new Error(typeof payload.code === "string" ? payload.code : "AUTHENTICATION_FAILED");
  }
  return payload;
}

export function SignInPanel({
  enabledProviders,
  initialMfa = false,
  initialMessage = null,
  returnTo = "/settings/security",
}: {
  enabledProviders: readonly ("google" | "discord")[];
  initialMfa?: boolean;
  initialMessage?: string | null;
  returnTo?: string;
}) {
  const router = useRouter();
  const [mfaPending, setMfaPending] = useState(initialMfa);
  const [message, setMessage] = useState<string | null>(initialMessage);
  const [working, setWorking] = useState(false);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setWorking(true);
    setMessage(null);
    const form = new FormData(event.currentTarget);
    try {
      const payload = await postAuth("/sign-in/email", {
        email: form.get("email"),
        password: form.get("password"),
        callbackURL: returnTo,
      });
      if (payload.twoFactorRedirect === true) {
        setMfaPending(true);
      } else {
        router.push(returnTo);
      }
    } catch (error) {
      setMessage(authMessage(error instanceof Error ? error.message : "AUTHENTICATION_FAILED"));
    } finally {
      setWorking(false);
    }
  }

  async function verifySecondFactor(event: FormEvent<HTMLFormElement>, recovery: boolean) {
    event.preventDefault();
    setWorking(true);
    setMessage(null);
    const form = new FormData(event.currentTarget);
    try {
      const payload = await postAuth(
        recovery ? "/two-factor/verify-recovery-code" : "/two-factor/verify-totp",
        recovery
          ? { code: form.get("code") }
          : { code: form.get("code"), trustDevice: false },
      );
      router.push(payload.requiresTotpRecovery === true ? "/settings/security?recover-totp=1" : returnTo);
    } catch (error) {
      setMessage(authMessage(error instanceof Error ? error.message : "SECOND_FACTOR_FAILED"));
    } finally {
      setWorking(false);
    }
  }

  async function socialSignIn(provider: "google" | "discord") {
    setWorking(true);
    setMessage(null);
    try {
      const payload = await postAuth("/sign-in/social", {
        provider,
        callbackURL: returnTo,
      });
      if (typeof payload.url !== "string") throw new Error("SOCIAL_SIGN_IN_UNAVAILABLE");
      window.location.assign(payload.url);
    } catch (error) {
      setMessage(authMessage(error instanceof Error ? error.message : "SOCIAL_SIGN_IN_UNAVAILABLE"));
      setWorking(false);
    }
  }

  return (
    <AuthPanel title={mfaPending ? "Xác minh bước hai" : "Đăng nhập"} description={mfaPending ? "Bước đầu đã thành công. Nhập mã từ ứng dụng xác thực." : "Dùng email đã xác minh hoặc tài khoản được hỗ trợ."}>

      {message ? <StatusBanner tone="error"><p>{message}</p></StatusBanner> : null}

      {!mfaPending ? (
        <>
          <form onSubmit={signIn} className="stack">
            <Field htmlFor="sign-in-email" label="Email" required><input id="sign-in-email" name="email" type="email" autoComplete="email" required /></Field>
            <Field htmlFor="sign-in-password" label="Mật khẩu" required><input id="sign-in-password" name="password" type="password" autoComplete="current-password" required /></Field>
            <button type="submit" disabled={working}>{working ? "Đang đăng nhập…" : "Đăng nhập"}</button>
            <div className="button-row auth-links"><Link className="text-link" href="/forgot-password">Quên mật khẩu?</Link><Link className="text-link" href="/register">Tạo tài khoản</Link></div>
          </form>
          {enabledProviders.length > 0 ? (
            <div className="stack compact social-auth" aria-label="Đăng nhập qua tài khoản khác">
              <div className="divider-label"><span>Hoặc</span></div>
              {enabledProviders.includes("google") ? (
                <button type="button" className="secondary" disabled={working} onClick={() => socialSignIn("google")}>
                  Tiếp tục với Google
                </button>
              ) : null}
              {enabledProviders.includes("discord") ? (
                <button type="button" className="secondary" disabled={working} onClick={() => socialSignIn("discord")}>
                  Tiếp tục với Discord
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      ) : (
        <div className="stack">
          <form onSubmit={(event) => verifySecondFactor(event, false)} className="stack">
            <Field htmlFor="totp-code" label="Mã xác thực" hint="Nhập 6–8 chữ số từ ứng dụng xác thực." required><input id="totp-code" name="code" inputMode="numeric" autoComplete="one-time-code" minLength={6} maxLength={8} required /></Field>
            <button type="submit" disabled={working}>{working ? "Đang xác minh…" : "Xác minh"}</button>
          </form>
          <details>
            <summary>Dùng mã khôi phục</summary>
            <form onSubmit={(event) => verifySecondFactor(event, true)} className="stack recovery-form">
              <Field htmlFor="recovery-code" label="Mã khôi phục" required><input id="recovery-code" name="code" autoComplete="off" required /></Field>
              <button type="submit" className="secondary" disabled={working}>Dùng mã khôi phục</button>
            </form>
          </details>
        </div>
      )}
    </AuthPanel>
  );
}
