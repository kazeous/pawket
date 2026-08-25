import { AuthJourneyForm } from "../auth-journey-form";
import { AuthJourneyPage } from "../auth-journey-page";

export default function ForgotPasswordPage() { return <AuthJourneyPage eyebrow="Khôi phục" title="Quên mật khẩu?" description="Pawket sẽ gửi hướng dẫn riêng tư nếu email khớp với một tài khoản."><AuthJourneyForm journey="forgot" /></AuthJourneyPage>; }
