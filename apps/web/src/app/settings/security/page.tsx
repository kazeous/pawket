import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getIdentityRuntime } from "../../../auth/runtime";
import {
  safeSocialAuthError,
  socialAuthGuidance,
} from "../../../auth/social-auth-guidance";
import { SecurityPanel } from "./security-panel";

export const dynamic = "force-dynamic";

export default async function SecuritySettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string | string[];
    "recover-totp"?: string | string[];
  }>;
}) {
  const runtime = getIdentityRuntime();
  const params = await searchParams;
  const session = await runtime.authenticate(await headers());
  if (!session) {
    const error = safeSocialAuthError(params.error);
    redirect(error ? `/sign-in?error=${encodeURIComponent(error)}` : "/sign-in");
  }
  const initialMessage = params.error
    ? socialAuthGuidance(params.error)
    : params["recover-totp"] === "1"
      ? "Recovery code accepted. Enroll a new authenticator now."
      : null;

  return (
    <main className="page-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">Account</p>
          <h1>Security settings</h1>
        </div>
        <Link href="/">Pawket home</Link>
      </header>
      <SecurityPanel
        enabledProviders={runtime.auth.enabledProviders}
        initialMessage={initialMessage}
      />
    </main>
  );
}
