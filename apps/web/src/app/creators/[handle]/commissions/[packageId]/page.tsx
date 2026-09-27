import type { Metadata } from "next";
import { PublicCommissionPackagePage } from "@/ui/commissions/commission-pages";
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Gói commission · Pawket", robots: { index: false, follow: false }, referrer: "no-referrer" };
export default async function Page({ params }: Readonly<{ params: Promise<{ handle: string; packageId: string }> }>) { return <PublicCommissionPackagePage {...await params} />; }
