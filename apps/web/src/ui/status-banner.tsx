import type { ReactNode } from "react";

export type StatusTone = "info" | "success" | "warning" | "error";

export function StatusBanner({
  children,
  title,
  tone = "info",
  id,
}: Readonly<{ children: ReactNode; title?: string; tone?: StatusTone; id?: string }>) {
  return (
    <div className="status-banner" data-tone={tone} id={id} role={tone === "error" ? "alert" : "status"}>
      <span className="status-mark" aria-hidden="true" />
      <div>{title ? <strong>{title}</strong> : null}<div>{children}</div></div>
    </div>
  );
}

export function StatusTag({ children, tone = "info" }: Readonly<{ children: ReactNode; tone?: StatusTone }>) {
  return <span className="status-tag" data-tone={tone}>{children}</span>;
}
