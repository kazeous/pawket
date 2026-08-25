import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { getIdentityRuntime } from "../../auth/runtime";
import { authenticatedEntryRedirect, resolvePublicSession } from "../../auth/public-session";
import { AuthJourneyForm } from "../auth-journey-form";
import { AuthJourneyPage } from "../auth-journey-page";

export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  const runtime = getIdentityRuntime();
  const destination = authenticatedEntryRedirect(
    await resolvePublicSession(runtime.authenticate, await headers()),
  );
  if (destination) redirect(destination);

  return <AuthJourneyPage eyebrow="Bắt đầu" title="Tạo tài khoản Pawket" description="Một tài khoản cho bảo mật, hồ sơ nhà sáng tạo và các công cụ sắp mở."><AuthJourneyForm journey="register" /><p className="muted">Đã có tài khoản? <Link className="text-link" href="/sign-in">Đăng nhập</Link></p></AuthJourneyPage>;
}
