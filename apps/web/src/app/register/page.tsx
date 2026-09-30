import Link from "next/link";
import { oidcSignUpUrl } from "@pawket/config";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { getIdentityRuntime } from "../../auth/runtime";
import { AppShell } from "../../ui/app-shell";

export const dynamic = "force-dynamic";
export default function RegisterPage() {
  // Sign-up happens at the shared account service; Pawket creates the buyer on the first verified login.
  const signUpUrl = oidcSignUpUrl(getIdentityRuntime().accountPortalUrl);
  return <AppShell width="narrow" context="Tài khoản">
    <div className="auth-layout reveal">
      <div className="auth-intro"><p className="eyebrow">Bắt đầu</p><h1>Tạo tài khoản Pawket.</h1><p>Một tài khoản chung để đăng nhập Pawket và quản lý bảo mật.</p></div>
      <Card>
        <CardHeader><CardTitle>Tài khoản reyuuGAMES</CardTitle><CardDescription>Đăng ký và xác minh email tại trang tài khoản chung.</CardDescription></CardHeader>
        <CardContent><p>Sau khi mở liên kết xác minh trong email, quay lại Pawket và đăng nhập.</p></CardContent>
        <CardFooter className="flex flex-wrap gap-3">
          <a className={buttonVariants()} href={signUpUrl} referrerPolicy="no-referrer">Tạo tài khoản với reyuuGAMES</a>
          <Link className={buttonVariants({ variant: "ghost" })} href="/sign-in">Đã có tài khoản? Đăng nhập</Link>
        </CardFooter>
      </Card>
    </div>
  </AppShell>;
}
