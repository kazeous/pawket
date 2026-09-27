import type { Metadata } from "next";
import { CommissionPackagesPage } from "@/ui/commissions/commission-pages";
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Gói commission · Pawket", robots: { index: false, follow: false }, referrer: "no-referrer" };
export default CommissionPackagesPage;
