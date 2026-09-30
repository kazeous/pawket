import { redirect } from "next/navigation";
export default function LegacyMfaPage() { redirect("/sign-in?notice=auth_moved"); }
