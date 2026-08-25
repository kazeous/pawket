import Link from "next/link";
import { AuthJourneyForm } from "../auth-journey-form";
import { AuthJourneyPage } from "../auth-journey-page";

export default function RegisterPage() { return <AuthJourneyPage eyebrow="Bắt đầu" title="Tạo tài khoản Pawket" description="Một tài khoản cho bảo mật, hồ sơ nhà sáng tạo và các công cụ sắp mở."><AuthJourneyForm journey="register" /><p className="muted">Đã có tài khoản? <Link className="text-link" href="/sign-in">Đăng nhập</Link></p></AuthJourneyPage>; }
