import type { ReactNode } from "react";

export function LoadingState({ label = "Đang tải…" }: Readonly<{ label?: string }>) {
  return <div className="async-state" role="status"><span className="spinner" aria-hidden="true" />{label}</div>;
}

export function EmptyState({ children, title }: Readonly<{ children?: ReactNode; title: string }>) {
  return <div className="async-state empty-state"><span className="empty-mark" aria-hidden="true" /><strong>{title}</strong>{children}</div>;
}

export function RetryState({ children, onRetry, title }: Readonly<{ children?: ReactNode; onRetry: () => void; title: string }>) {
  return <div className="async-state"><strong>{title}</strong>{children}<button type="button" className="secondary" onClick={onRetry}>Tải lại</button></div>;
}
