import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: "no-referrer" };
export default function LockedHelpLayout({ children }: Readonly<{ children: ReactNode }>) { return children; }
