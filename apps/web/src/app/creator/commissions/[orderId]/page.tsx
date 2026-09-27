import type { Metadata } from "next";
import { CommissionDetailPage } from "@/ui/commissions/commission-pages";
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Chi tiết commission · Pawket", robots: { index: false, follow: false }, referrer: "no-referrer" };
export default async function Page({ params }: Readonly<{ params: Promise<{ orderId: string }> }>) { return <CommissionDetailPage role="creator" orderId={(await params).orderId} />; }
