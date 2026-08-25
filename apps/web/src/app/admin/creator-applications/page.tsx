import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { getIdentityRuntime } from "../../../auth/runtime";

export const dynamic = "force-dynamic";

export default async function CreatorApplicationsAdminPage() {
  const decision = await getIdentityRuntime().authorizeOwner(await headers());
  if (decision === "unauthenticated") redirect("/sign-in");
  if (decision !== "authorized") notFound();

  const applications = await getIdentityRuntime().creatorReview.listSubmitted();

  return (
    <main className="page-shell narrow-shell">
      <section className="panel">
        <p className="eyebrow">Owner-only</p>
        <h1>Creator applications</h1>
        <p>Submitted applications are ordered oldest first. Receiving-account destinations remain masked here.</p>
        {applications.length === 0 ? <p>No submitted applications.</p> : <ul>
          {applications.map((application) => (
            <li key={application.id}>
              <strong>{application.artistDisplayName ?? "Unnamed artist"}</strong> — {application.primaryArtDiscipline ?? "Practice not supplied"}; email {application.emailVerified ? "verified" : "unverified"}; age snapshot {application.ageEligible ? "eligible" : "not eligible"}; {application.bankName ?? "Receiving account unavailable"} {application.maskedSuffix ?? ""} ({application.proofState ?? "unverified"}).
              <p>Review via the owner API using version {application.version}; full bank data is intentionally unavailable in this view.</p>
            </li>
          ))}
        </ul>}
      </section>
    </main>
  );
}
