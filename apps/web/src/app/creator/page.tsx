import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { getIdentityRuntime } from "../../auth/runtime";

export const dynamic = "force-dynamic";

export default async function CreatorShellPage() {
  const decision = await getIdentityRuntime().authorizeCreator(await headers());
  if (decision === "unauthenticated") redirect("/sign-in");
  if (decision !== "authorized") notFound();
  return (
    <main className="page-shell narrow-shell">
      <section className="panel">
        <p className="eyebrow">Creator access approved</p>
        <h1>Creator area</h1>
        <p>Publishing arrives in the next increment.</p>
      </section>
    </main>
  );
}
