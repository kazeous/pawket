import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getPlatformRuntime } from "../../../../platform/runtime";
import { AppShell } from "../../../../ui/app-shell";
import { CommandReview } from "./review-panel";

export const dynamic = "force-dynamic";
export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id)) notFound();
  const runtime = getPlatformRuntime(); const actor = await runtime.authenticate(await headers(), true);
  if (!actor || actor.leaseRequired) redirect(`/sign-in?returnTo=${encodeURIComponent(`/auth/review/${id}`)}`);
  return <AppShell width="narrow" context="Xác nhận thao tác"><CommandReview id={id} accountPortalUrl={runtime.accountPortalUrl} /></AppShell>;
}
