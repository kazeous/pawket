import Link from "next/link";
import type { ReactNode } from "react";

import { AccountSessionControl } from "./account-session-control";

type ShellAction = Readonly<{ href: string; label: string }>;

export function AppShell({
  children,
  action = { href: "/sign-in", label: "Đăng nhập" },
  context,
  width = "wide",
}: Readonly<{
  children: ReactNode;
  action?: ShellAction | null;
  context?: string;
  width?: "wide" | "narrow";
}>) {
  return (
    <div className="site-frame">
      <header className="site-header">
        <Link className="wordmark" href="/" aria-label="Pawket — trang chủ">
          Pawket<span aria-hidden="true">.</span>
        </Link>
        {context ? <p className="site-context">{context}</p> : <span />}
        <AccountSessionControl action={action} />
      </header>
      <main className={width === "narrow" ? "page-shell narrow-shell" : "page-shell"}>
        {children}
      </main>
      <footer className="site-footer">
        <p>Pawket · công cụ cho nhà sáng tạo · 2026</p>
      </footer>
    </div>
  );
}
