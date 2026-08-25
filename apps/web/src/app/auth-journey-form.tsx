"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useState } from "react";

import { Field } from "../ui/field";
import { StatusBanner } from "../ui/status-banner";

type Journey = "register" | "resend" | "verify" | "forgot" | "reset" | "confirm-email";

const copy: Record<Journey, { action: string; pending: string; success: string }> = {
  register: { action: "Tạo tài khoản", pending: "Đang tạo tài khoản…", success: "Hãy kiểm tra hộp thư để xác minh email. Nếu địa chỉ có thể đăng ký, Pawket đã gửi hướng dẫn." },
  resend: { action: "Gửi lại email", pending: "Đang gửi…", success: "Nếu địa chỉ này có tài khoản chưa xác minh, Pawket đã gửi một email mới." },
  verify: { action: "Xác minh email", pending: "Đang xác minh…", success: "Email đã được xác minh. Bạn có thể đăng nhập." },
  forgot: { action: "Gửi hướng dẫn", pending: "Đang gửi…", success: "Nếu địa chỉ này có tài khoản, Pawket đã gửi hướng dẫn đặt lại mật khẩu." },
  reset: { action: "Đặt mật khẩu mới", pending: "Đang cập nhật…", success: "Mật khẩu đã được cập nhật. Các phiên cũ không còn hiệu lực." },
  "confirm-email": { action: "Xác nhận email mới", pending: "Đang xác nhận…", success: "Email đăng nhập đã được cập nhật. Các phiên khác đã được thu hồi." },
};

function errorMessage(code: string): string {
  switch (code) {
    case "INVALID_OR_EXPIRED_CHALLENGE": return "Liên kết không hợp lệ hoặc đã hết hạn. Hãy yêu cầu một liên kết mới.";
    case "POLICY_REJECTED": return "Mật khẩu chưa đạt yêu cầu. Dùng ít nhất 15 ký tự và tránh thông tin dễ đoán.";
    case "RATE_LIMITED": return "Bạn thao tác quá nhanh. Hãy đợi một lúc rồi thử lại.";
    case "SECURITY_EMAIL_UNAVAILABLE": return "Dịch vụ email bảo mật đang tạm gián đoạn. Hãy thử lại sau.";
    case "AUTHENTICATION_REQUIRED": return "Bạn cần đăng nhập lại trước khi xác nhận email mới.";
    case "EMAIL_UNAVAILABLE": return "Email này không thể sử dụng. Hãy chọn địa chỉ khác.";
    default: return "Pawket chưa thể hoàn tất yêu cầu. Hãy thử lại sau.";
  }
}

export function AuthJourneyForm({ journey }: Readonly<{ journey: Journey }>) {
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const consumesToken = journey === "verify" || journey === "reset" || journey === "confirm-email";
  const [challengeToken, setChallengeToken] = useState<string | null>(consumesToken ? null : "");
  const needsEmail = journey === "register" || journey === "resend" || journey === "forgot";
  const needsPassword = journey === "register" || journey === "reset";
  const endpoint: Record<Journey, string> = {
    register: "/api/v1/auth/register",
    resend: "/api/v1/auth/email-verification/resend",
    verify: "/api/v1/auth/email-verification/complete",
    forgot: "/api/v1/auth/password-reset/request",
    reset: "/api/v1/auth/password-reset/complete",
    "confirm-email": "/api/v1/me/email-change/complete",
  };

  useEffect(() => {
    if (!consumesToken) return;
    const timer = window.setTimeout(() => {
      const currentUrl = new URL(window.location.href);
      setChallengeToken(currentUrl.searchParams.get("token") ?? "");
      window.history.replaceState(window.history.state, "", `${currentUrl.pathname}${currentUrl.hash}`);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [consumesToken]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setWorking(true);
    setResult(null);
    const data = new FormData(event.currentTarget);
    const body: Record<string, FormDataEntryValue | string> = {};
    if (journey === "register") body.name = data.get("name") ?? "";
    if (needsEmail) body.email = data.get("email") ?? "";
    if (needsPassword) body[journey === "reset" ? "newPassword" : "password"] = data.get("password") ?? "";
    if (consumesToken) body.token = challengeToken ?? "";

    try {
      const response = await fetch(endpoint[journey], {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => ({}))) as { code?: string };
      if (!response.ok) throw new Error(payload.code ?? "REQUEST_FAILED");
      setResult({ tone: "success", message: copy[journey].success });
    } catch (error) {
      setResult({ tone: "error", message: errorMessage(error instanceof Error ? error.message : "REQUEST_FAILED") });
    } finally {
      setWorking(false);
    }
  }

  const tokenLoading = consumesToken && challengeToken === null;
  const tokenMissing = consumesToken && challengeToken !== null && challengeToken.length < 16;

  return (
    <form className="stack" onSubmit={submit} noValidate>
      {journey === "register" ? <Field htmlFor="name" label="Tên hiển thị" required><input id="name" name="name" autoComplete="name" required maxLength={100} /></Field> : null}
      {needsEmail ? <Field htmlFor="email" label="Email" hint="Pawket không tiết lộ địa chỉ này có tài khoản hay chưa." required><input id="email" name="email" type="email" autoComplete="email" required maxLength={254} /></Field> : null}
      {needsPassword ? <Field htmlFor="password" label={journey === "reset" ? "Mật khẩu mới" : "Mật khẩu"} hint="Từ 15 đến 128 ký tự; tránh tên và thông tin dễ đoán." required><input id="password" name="password" type="password" autoComplete="new-password" minLength={15} maxLength={128} required /></Field> : null}
      {tokenMissing ? <StatusBanner tone="error" title="Liên kết chưa đầy đủ"><p>Hãy mở lại đường dẫn đầy đủ trong email Pawket.</p></StatusBanner> : null}
      {result ? <StatusBanner tone={result.tone}><p>{result.message}</p>{result.tone === "success" && (journey === "verify" || journey === "reset") ? <p><Link className="text-link" href="/sign-in">Đến trang đăng nhập</Link></p> : null}</StatusBanner> : null}
      <button type="submit" disabled={working || tokenLoading || tokenMissing}>{working ? copy[journey].pending : tokenLoading ? "Đang đọc liên kết…" : copy[journey].action}</button>
    </form>
  );
}
