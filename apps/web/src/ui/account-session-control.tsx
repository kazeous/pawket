"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type ShellAction = Readonly<{ href: string; label: string }>;

type AccountSummary = Readonly<{
  displayEmail: string;
  displayName: string;
}>;

export type AccountControlState =
  | "idle"
  | "loading"
  | "disabled"
  | "error"
  | "success";

type AccountAvailability = "loading" | "authenticated" | "anonymous" | "error";

function isAccountSummary(value: unknown): value is AccountSummary {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.displayEmail === "string" &&
    candidate.displayEmail.length > 0 &&
    typeof candidate.displayName === "string"
  );
}

function authenticatedAction(action: ShellAction | null): ShellAction | null {
  if (!action || action.href === "/sign-in" || action.href === "/register") return null;
  return action;
}

export function AccountSessionControlView({
  account,
  action,
  buttonClassName,
  onSignOut,
  state = "idle",
}: Readonly<{
  account: AccountSummary;
  action: ShellAction | null;
  buttonClassName?: string;
  onSignOut?: () => void;
  state?: AccountControlState;
}>) {
  const disabled = state === "loading" || state === "disabled" || state === "success";
  const buttonLabel =
    state === "loading"
      ? "Đang đăng xuất…"
      : state === "success"
        ? "Đã đăng xuất"
        : "Đăng xuất";
  const identityLabel =
    state === "error"
      ? "Không thể đăng xuất. Hãy thử lại."
      : state === "loading"
        ? "Đang kết thúc phiên"
        : "Đã đăng nhập";
  const nextAction = authenticatedAction(action);

  return (
    <div className="account-session" data-state={state}>
      <p className="account-identity" title={account.displayEmail}>
        <span role={state === "error" ? "status" : undefined}>{identityLabel}</span>
        <strong>{account.displayEmail}</strong>
      </p>
      <div className="account-actions">
        {nextAction ? (
          <Link className="header-account-link" href={nextAction.href}>
            {nextAction.label}
          </Link>
        ) : null}
        <button
          className={["account-signout", "secondary", buttonClassName].filter(Boolean).join(" ")}
          data-state={state}
          disabled={disabled}
          aria-busy={state === "loading"}
          onClick={onSignOut}
          type="button"
        >
          {state === "loading" ? <span className="account-signout-spinner" aria-hidden="true" /> : null}
          {buttonLabel}
        </button>
      </div>
    </div>
  );
}

export function AccountSessionControl({
  action,
}: Readonly<{
  action: ShellAction | null;
}>) {
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [availability, setAvailability] = useState<AccountAvailability>("loading");
  const [controlState, setControlState] = useState<AccountControlState>("idle");

  const loadAccount = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch("/api/v1/me", {
        cache: "no-store",
        credentials: "include",
        headers: { accept: "application/json" },
        signal,
      });
      if (response.status === 401) {
        setAccount(null);
        setAvailability("anonymous");
        return;
      }
      if (!response.ok) throw new Error("ACCOUNT_LOOKUP_FAILED");
      const payload = (await response.json()) as { user?: unknown };
      if (!isAccountSummary(payload.user)) throw new Error("ACCOUNT_LOOKUP_FAILED");
      setAccount(payload.user);
      setAvailability("authenticated");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setAccount(null);
      setAvailability("error");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => void loadAccount(controller.signal));
    return () => controller.abort();
  }, [loadAccount]);

  async function signOut() {
    setControlState("loading");
    try {
      const response = await fetch("/api/auth/sign-out", {
        method: "POST",
        credentials: "include",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      if (!response.ok) throw new Error("SIGN_OUT_FAILED");
      setControlState("success");
      setAccount(null);
      setAvailability("anonymous");
      window.location.replace("/sign-in");
    } catch {
      setControlState("error");
    }
  }

  function retryAccountLookup() {
    setAvailability("loading");
    void loadAccount();
  }

  if (availability === "authenticated" && account) {
    return (
      <AccountSessionControlView
        account={account}
        action={action}
        onSignOut={() => void signOut()}
        state={controlState}
      />
    );
  }

  if (availability === "error") {
    return (
      <div className="account-session account-session-error" role="status">
        <p className="account-identity">
          <span>Không thể xác định phiên</span>
          <strong>Kiểm tra lại kết nối</strong>
        </p>
        <button className="account-retry secondary" onClick={retryAccountLookup} type="button">
          Thử lại
        </button>
      </div>
    );
  }

  if (availability === "anonymous") {
    const anonymousAction =
      action && (action.href === "/sign-in" || action.href === "/register")
        ? action
        : { href: "/sign-in", label: "Đăng nhập" };
    return (
      <Link className="header-action" href={anonymousAction.href}>
        {anonymousAction.label}
      </Link>
    );
  }

  return (
    <div className="account-session account-session-loading" aria-busy="true">
      <span className="visually-hidden">Đang kiểm tra phiên đăng nhập</span>
      {action ? (
        <Link className="header-action" href={action.href}>
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}
