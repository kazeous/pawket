import { AppShell } from "@/ui/app-shell";
import { CurrentHelpPolicy } from "@/ui/help/help-policy";

export const dynamic = "force-dynamic";
export default function HelpPage() {
  return <AppShell context="Trung tâm trợ giúp"><section className="flex min-w-0 flex-col gap-6"><header><p className="eyebrow">Pawket</p><h1>Trung tâm trợ giúp</h1></header>
    <nav aria-label="Trợ giúp"><a href="/help" aria-current="page" className="underline">Chính sách</a>{" · "}<a href="/help/cases" className="underline">Yêu cầu của tôi</a></nav><CurrentHelpPolicy />
  </section></AppShell>;
}
