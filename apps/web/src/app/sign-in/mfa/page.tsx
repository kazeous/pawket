import { isAllowedReturnPath } from "@pawket/identity";

import { SignInPanel } from "../sign-in-panel";

export const dynamic = "force-dynamic";

export default async function MfaSignInPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  const requestedReturn = (await searchParams).returnTo;
  const returnTo =
    typeof requestedReturn === "string" && isAllowedReturnPath(requestedReturn)
      ? requestedReturn
      : "/settings/security";
  return (
    <main className="page-shell narrow-shell">
      <SignInPanel enabledProviders={[]} initialMfa returnTo={returnTo} />
    </main>
  );
}
