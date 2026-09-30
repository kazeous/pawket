import { redirect } from "next/navigation";
export default function ReauthenticatePage() { redirect("/sign-in?notice=auth_moved"); }
