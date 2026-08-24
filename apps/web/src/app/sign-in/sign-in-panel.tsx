"use client";

import { type FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

type AuthPayload = Record<string, unknown>;

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
      setMessage(error instanceof Error ? error.message : "AUTHENTICATION_FAILED");
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
      setMessage(error instanceof Error ? error.message : "SECOND_FACTOR_FAILED");
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
      setMessage(error instanceof Error ? error.message : "SOCIAL_SIGN_IN_UNAVAILABLE");
      setWorking(false);
    }
  }

  return (
    <section className="panel auth-panel" aria-labelledby="sign-in-title">
      <h1 id="sign-in-title">Sign in to Pawket</h1>
      <p>Use your verified email or a supported social identity.</p>

      {!mfaPending ? (
        <>
          <form onSubmit={signIn} className="stack">
            <label>
              Email
              <input name="email" type="email" autoComplete="email" required />
            </label>
            <label>
              Password
              <input name="password" type="password" autoComplete="current-password" required />
            </label>
            <button type="submit" disabled={working}>Sign in</button>
          </form>
          {enabledProviders.length > 0 ? (
            <div className="button-row" aria-label="Social sign in">
              {enabledProviders.includes("google") ? (
                <button type="button" className="secondary" disabled={working} onClick={() => socialSignIn("google")}>
                  Continue with Google
                </button>
              ) : null}
              {enabledProviders.includes("discord") ? (
                <button type="button" className="secondary" disabled={working} onClick={() => socialSignIn("discord")}>
                  Continue with Discord
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      ) : (
        <div className="stack">
          <p>Your primary sign-in succeeded. Enter a TOTP code to finish.</p>
          <form onSubmit={(event) => verifySecondFactor(event, false)} className="inline-form">
            <input name="code" inputMode="numeric" autoComplete="one-time-code" minLength={6} maxLength={8} required aria-label="TOTP code" />
            <button type="submit" disabled={working}>Verify TOTP</button>
          </form>
          <details>
            <summary>Use a recovery code</summary>
            <form onSubmit={(event) => verifySecondFactor(event, true)} className="inline-form">
              <input name="code" autoComplete="off" required aria-label="Recovery code" />
              <button type="submit" className="secondary" disabled={working}>Use recovery code</button>
            </form>
          </details>
        </div>
      )}

      {message ? <p role="alert" className="error-message">{message}</p> : null}
    </section>
  );
}
