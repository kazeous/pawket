import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { getIdentityRuntime } from "../../../auth/runtime";

export const dynamic = "force-dynamic";

export default async function CreatorApplicationsAdminPage() {
  const decision = await getIdentityRuntime().authorizeOwner(await headers());
  if (decision === "unauthenticated") redirect("/sign-in");
  if (decision !== "authorized") notFound();

  return (
    <main className="page-shell narrow-shell">
      <section className="panel">
        <p className="eyebrow">Owner-only</p>
        <h1>Creator applications</h1>
        <p>
          The owner gate is active. Application review arrives in the later creator-approval task.
        </p>
      </section>
    </main>
  );
}
