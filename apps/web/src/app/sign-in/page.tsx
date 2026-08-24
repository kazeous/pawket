import { SignInPanel } from "./sign-in-panel";
import { getIdentityRuntime } from "../../auth/runtime";
import { socialAuthGuidance } from "../../auth/social-auth-guidance";

export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const params = await searchParams;
  return (
    <main className="page-shell narrow-shell">
      <SignInPanel
        enabledProviders={getIdentityRuntime().auth.enabledProviders}
        initialMessage={socialAuthGuidance(params.error)}
      />
    </main>
  );
}
