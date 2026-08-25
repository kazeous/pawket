import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { getIdentityRuntime } from "../../auth/runtime";
import { AppShell } from "../../ui/app-shell";

export const dynamic = "force-dynamic";

export default async function CreatorShellPage() {
  const decision = await getIdentityRuntime().authorizeCreator(await headers());
  if (decision === "unauthenticated") redirect("/sign-in");
  if (decision !== "authorized") notFound();
  return (
    <AppShell width="narrow" context="Creator" action={{ href: "/settings/security", label: "Bảo mật" }}>
      <section className="work-surface reveal"><p className="eyebrow">Quyền creator đã mở</p><h1>Góc làm việc creator</h1><p className="lede">Công cụ xuất bản sẽ đến ở increment tiếp theo. Hiện tại bạn có thể quản lý bảo mật tài khoản.</p>
      </section>
    </AppShell>
  );
}
