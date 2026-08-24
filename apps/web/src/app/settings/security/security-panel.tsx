"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";

type Account = { id: string; providerId: string };
type Session = { id: string; deviceLabel: string; createdAt: string; lastUsedAt: string };

async function requestJson(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(path, { credentials: "include", ...init });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof payload.code === "string" ? payload.code : "SECURITY_ACTION_FAILED");
  }
  return payload;
}

const jsonPost = (body: Record<string, unknown>): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export function SecurityPanel({
  enabledProviders,
  initialMessage = null,
}: {
  enabledProviders: readonly ("google" | "discord")[];
  initialMessage?: string | null;
}) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [totpURI, setTotpURI] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(initialMessage);
  const [working, setWorking] = useState(false);

  const loadSecurityState = useCallback(async () => {
    const [accountPayload, sessionPayload] = await Promise.all([
      requestJson("/api/auth/list-accounts"),
      requestJson("/api/v1/me/sessions"),
    ]);
    const rawAccounts = Array.isArray(accountPayload) ? accountPayload : accountPayload.accounts;
    setAccounts(
      Array.isArray(rawAccounts)
        ? rawAccounts.filter(
            (account): account is Account =>
              Boolean(account) &&
              typeof account === "object" &&
              typeof (account as Account).id === "string" &&
              typeof (account as Account).providerId === "string",
          )
        : [],
    );
    setSessions(Array.isArray(sessionPayload.sessions) ? (sessionPayload.sessions as Session[]) : []);
  }, []);

  useEffect(() => {
    let current = true;
    Promise.all([
      requestJson("/api/auth/list-accounts"),
      requestJson("/api/v1/me/sessions"),
    ]).then(([accountPayload, sessionPayload]) => {
      if (!current) return;
      const rawAccounts = Array.isArray(accountPayload) ? accountPayload : accountPayload.accounts;
      setAccounts(
        Array.isArray(rawAccounts)
          ? rawAccounts.filter(
              (account): account is Account =>
                Boolean(account) &&
                typeof account === "object" &&
                typeof (account as Account).id === "string" &&
                typeof (account as Account).providerId === "string",
            )
          : [],
      );
      setSessions(Array.isArray(sessionPayload.sessions) ? (sessionPayload.sessions as Session[]) : []);
    }).catch(() => {
      if (current) setMessage("SECURITY_STATE_UNAVAILABLE");
    });
    return () => {
      current = false;
    };
  }, []);

  async function run(action: () => Promise<void>) {
    setWorking(true);
    setMessage(null);
    try {
      await action();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "SECURITY_ACTION_FAILED");
    } finally {
      setWorking(false);
    }
  }

  function linkProvider(provider: "google" | "discord") {
    return run(async () => {
      const payload = await requestJson("/api/auth/link-social", jsonPost({
        provider,
        callbackURL: "/settings/security",
      }));
      if (typeof payload.url !== "string") throw new Error("SOCIAL_LINK_UNAVAILABLE");
      window.location.assign(payload.url);
    });
  }

  function unlinkAccount(accountId: string) {
    return run(async () => {
      await requestJson("/api/auth/unlink-account", jsonPost({ accountId }));
      await loadSecurityState();
      setMessage("Sign-in method removed.");
    });
  }

  function beginTotp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    return run(async () => {
      const password = form.get("password");
      const payload = await requestJson(
        "/api/auth/two-factor/enable",
        jsonPost({
          method: "totp",
          ...(typeof password === "string" && password.length > 0 ? { password } : {}),
        }),
      );
      if (typeof payload.totpURI !== "string") throw new Error("TOTP_ENROLLMENT_UNAVAILABLE");
      setTotpURI(payload.totpURI);
      setMessage("Add this setup URI to your authenticator, then verify one code.");
    });
  }

  function verifyTotp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    return run(async () => {
      const payload = await requestJson("/api/auth/two-factor/verify-totp", jsonPost({
        code: form.get("code"),
        trustDevice: false,
      }));
      setTotpURI(null);
      setRecoveryCodes(Array.isArray(payload.recoveryCodes) ? (payload.recoveryCodes as string[]) : []);
      setMessage("TOTP verified.");
    });
  }

  function regenerateRecoveryCodes() {
    return run(async () => {
      const payload = await requestJson(
        "/api/auth/two-factor/regenerate-recovery-codes",
        jsonPost({}),
      );
      setRecoveryCodes(Array.isArray(payload.recoveryCodes) ? (payload.recoveryCodes as string[]) : []);
      setMessage("Previous recovery codes are now invalid.");
    });
  }

  function revokeSession(sessionId: string) {
    return run(async () => {
      const response = await fetch(`/api/v1/me/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok) throw new Error("SESSION_REVOCATION_FAILED");
      await loadSecurityState();
    });
  }

  return (
    <div className="stack page-grid">
      <section className="panel">
        <h2>Sign-in methods</h2>
        <div className="stack compact">
          {accounts.map((account) => (
            <div className="item-row" key={account.id}>
              <span>{account.providerId}</span>
              {account.providerId === "google" || account.providerId === "discord" ? (
                <button type="button" className="secondary" disabled={working} onClick={() => unlinkAccount(account.id)}>
                  Remove
                </button>
              ) : null}
            </div>
          ))}
          {enabledProviders.length > 0 ? (
            <div className="button-row">
              {enabledProviders.includes("google") ? (
                <button type="button" disabled={working} onClick={() => linkProvider("google")}>Link Google</button>
              ) : null}
              {enabledProviders.includes("discord") ? (
                <button type="button" disabled={working} onClick={() => linkProvider("discord")}>Link Discord</button>
              ) : null}
            </div>
          ) : null}
          <small>Removing the last sign-in method is always refused.</small>
        </div>
      </section>

      <section className="panel">
        <h2>Authenticator app</h2>
        <form onSubmit={beginTotp} className="inline-form">
          <input name="password" type="password" autoComplete="current-password" placeholder="Current password, if set" />
          <button type="submit" disabled={working}>Start TOTP setup</button>
        </form>
        {totpURI ? (
          <div className="stack compact">
            <code className="breakable secret-display">{totpURI}</code>
            <form onSubmit={verifyTotp} className="inline-form">
              <input name="code" inputMode="numeric" autoComplete="one-time-code" required aria-label="TOTP code" />
              <button type="submit" disabled={working}>Verify setup</button>
            </form>
          </div>
        ) : null}
        <button type="button" className="secondary" disabled={working} onClick={regenerateRecoveryCodes}>
          Replace recovery codes
        </button>
        {recoveryCodes.length > 0 ? (
          <div className="recovery-block" role="status">
            <strong>Save these once. Pawket will not show them again.</strong>
            <ol>{recoveryCodes.map((code) => <li key={code}><code>{code}</code></li>)}</ol>
          </div>
        ) : null}
      </section>

      <section className="panel">
        <h2>Active sessions</h2>
        <div className="stack compact">
          {sessions.map((session) => (
            <div className="item-row" key={session.id}>
              <span>{session.deviceLabel}</span>
              <button type="button" className="secondary" disabled={working} onClick={() => revokeSession(session.id)}>
                Revoke
              </button>
            </div>
          ))}
        </div>
      </section>

      {message ? <p role="status" className="status-message">{message}</p> : null}
    </div>
  );
}
