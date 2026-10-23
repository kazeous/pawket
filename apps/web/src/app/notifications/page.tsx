import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getPlatformRuntime } from "@/platform/runtime";
import { AppShell } from "@/ui/app-shell";
import { NotificationInbox } from "@/ui/notifications/notification-inbox";

export const dynamic = "force-dynamic";
export default async function NotificationsPage() {
  const platform = getPlatformRuntime();
  if (platform.notifications.mode !== "enabled") notFound();
  const actor = await platform.authenticate(await headers());
  if (!actor) redirect("/sign-in?returnTo=/notifications");
  const initial = await platform.notifications.list(actor.userId, null);
  return <AppShell context="Tài khoản" action={{ href: "/settings/security", label: "Tài khoản" }}>
    <section className="flex min-w-0 flex-col gap-6"><h1>Thông báo</h1><NotificationInbox initial={initial} /></section>
  </AppShell>;
}
