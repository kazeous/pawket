import { redirect } from "next/navigation";
export default function MovedAccountPage() { redirect("/sign-in?notice=auth_moved"); }
