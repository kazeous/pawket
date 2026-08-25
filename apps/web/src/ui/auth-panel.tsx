import type { ReactNode } from "react";

export function AuthPanel({ children, description, title }: Readonly<{ children: ReactNode; description: string; title: string }>) {
  return <section className="auth-panel" aria-labelledby="auth-title"><div className="auth-heading"><h2 id="auth-title">{title}</h2><p>{description}</p></div>{children}</section>;
}
