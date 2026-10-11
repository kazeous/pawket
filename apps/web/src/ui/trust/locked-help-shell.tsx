import type { ReactNode } from "react";
import { StatusBanner } from "@/ui/status-banner";

export function LockedHelpShell({ children, title }: Readonly<{ children: ReactNode; title: string }>) {
  return <div className="site-frame"><header className="site-header"><a className="wordmark" href="/help">Pawket<span aria-hidden="true">.</span></a><p className="site-context">Trung tâm trợ giúp</p></header>
    <main className="page-shell narrow-shell"><section className="flex min-w-0 flex-col gap-6"><header><p className="eyebrow">Pawket</p><h1>{title}</h1></header>{children}</section></main>
    <footer className="site-footer"><a href="/help">Chính sách</a></footer></div>;
}
export function ExpiredHelpLink({ allowResend = true }: Readonly<{ allowResend?: boolean }>) {
  return <StatusBanner><p>Liên kết không còn hiệu lực.</p><a className="underline" href={allowResend ? "/help/locked/resend" : "/help"}>{allowResend ? "Yêu cầu liên kết mới" : "Trung tâm trợ giúp"}</a></StatusBanner>;
}
