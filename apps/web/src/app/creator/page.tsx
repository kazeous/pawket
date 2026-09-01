import { randomUUID } from "node:crypto";

import { loadServerEnv } from "@pawket/config";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { getPlatformRuntime } from "../../platform/runtime";
import { AppShell } from "../../ui/app-shell";
import { CreatorPageWorkbench } from "./creator-page-workbench";

export const dynamic = "force-dynamic";

export default async function CreatorShellPage() {
  const requestHeaders = await headers();
  const platform = getPlatformRuntime();
  const session = await platform.authenticate(requestHeaders);
  if (!session) redirect("/sign-in");
  const decision = await platform.authorizeCreator(requestHeaders);
  if (decision !== "authorized") notFound();

  if (loadServerEnv().CREATOR_PUBLISHING_MODE === "disabled") {
    return (
      <AppShell width="narrow" context="Creator" action={{ href: "/settings/security", label: "Bảo mật" }}>
        <section className="work-surface reveal stack">
          <p className="eyebrow">Creator workspace</p>
          <h1>Trang nhà sáng tạo chưa khả dụng</h1>
          <p className="lede">Chế độ xuất bản đang tắt. Không có thao tác thay đổi trang hoặc media nào được mở.</p>
        </section>
      </AppShell>
    );
  }

  const workspace = await platform.catalog.initialize({
    userId: session.userId,
    requestId: requestHeaders.get("x-request-id") ?? randomUUID(),
  });
  return (
    <AppShell context="Creator" action={{ href: "/settings/security", label: "Bảo mật" }}>
      <header className="workspace-header reveal">
        <div>
          <p className="eyebrow">Bản nháp riêng tư → trang công khai</p>
          <h1>Góc làm việc trang nhà sáng tạo</h1>
          <p className="lede">Chỉnh sửa bản nháp, xem trước riêng tư và chỉ xuất bản khi bạn sẵn sàng.</p>
        </div>
      </header>
      <CreatorPageWorkbench initialWorkspace={workspace} />
    </AppShell>
  );
}
