import type { Metadata } from "next";
import { CommissionListPage } from "@/ui/commissions/commission-pages";
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Yêu cầu commission · Pawket", robots: { index: false, follow: false }, referrer: "no-referrer" };
export default function Page() { return <CommissionListPage role="creator" />; }
