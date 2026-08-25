import type { ReactNode } from "react";

import { AppShell } from "../ui/app-shell";
import { AuthPanel } from "../ui/auth-panel";

export function AuthJourneyPage({ children, description, eyebrow, title }: Readonly<{ children: ReactNode; description: string; eyebrow: string; title: string }>) {
  return (
    <AppShell width="narrow" action={{ href: "/sign-in", label: "Đăng nhập" }} context="Tài khoản">
      <div className="auth-layout reveal">
        <div className="auth-intro"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>
        <AuthPanel title="Thông tin cần thiết" description="Pawket chỉ hỏi những gì cần cho bước này.">{children}</AuthPanel>
      </div>
    </AppShell>
  );
}
