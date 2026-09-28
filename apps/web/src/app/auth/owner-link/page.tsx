import type { Metadata } from "next";
import { loadServerEnv, parseOidcEnv } from "@pawket/config";
import { AppShell } from "@/ui/app-shell";
import { OwnerLinkPanel } from "./owner-link-panel";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Liên kết owner · Pawket", robots: { index: false, follow: false }, referrer: "no-referrer" };
export default function OwnerLinkPage() {
  const env = loadServerEnv(); const provider = parseOidcEnv(process.env, env.APP_BASE_URL);
  return <AppShell context="Liên kết tài khoản quản trị" width="narrow"><OwnerLinkPanel accountPortalUrl={provider.accountPortalUrl} /></AppShell>;
}
