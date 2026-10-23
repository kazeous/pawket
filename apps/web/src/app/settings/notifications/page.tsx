import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getPlatformRuntime } from "@/platform/runtime";
import { AppShell } from "@/ui/app-shell";
import { NotificationPreferences } from "@/ui/notifications/notification-preferences";

export const dynamic = "force-dynamic";
export default async function NotificationSettingsPage() {
  const platform = getPlatformRuntime();
  if (platform.notifications.mode !== "enabled") notFound();
  const actor = await platform.authenticate(await headers());
  if (!actor) redirect("/sign-in?returnTo=/settings/notifications");
  const initial = await platform.notifications.readPreferences(actor.userId);
  return <AppShell context="Tài khoản" action={{ href: "/settings/security", label: "Tài khoản" }}>
    <section className="flex min-w-0 flex-col gap-6"><h1>Cài đặt thông báo</h1><Link className="underline" href="/notifications">Xem thông báo</Link>
      <NotificationPreferences initial={initial} /></section>
  </AppShell>;
}
