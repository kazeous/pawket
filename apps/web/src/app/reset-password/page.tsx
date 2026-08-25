import { AuthJourneyForm } from "../auth-journey-form";
import { AuthJourneyPage } from "../auth-journey-page";

export default function ResetPasswordPage() { return <AuthJourneyPage eyebrow="Khôi phục" title="Đặt mật khẩu mới" description="Chọn một mật khẩu dài, riêng và chưa dùng ở nơi khác."><AuthJourneyForm journey="reset" /></AuthJourneyPage>; }
