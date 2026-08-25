import type { ReactNode } from "react";

export type SummaryItem = Readonly<{ label: string; value: ReactNode }>;

export function SummaryList({ items }: Readonly<{ items: readonly SummaryItem[] }>) {
  return <dl className="summary-list">{items.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>;
}
