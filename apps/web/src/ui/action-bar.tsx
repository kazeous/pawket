import type { ReactNode } from "react";

export function ActionBar({ children, note }: Readonly<{ children: ReactNode; note?: ReactNode }>) {
  return <div className="action-bar">{note ? <p>{note}</p> : <span />}<div className="button-row">{children}</div></div>;
}
