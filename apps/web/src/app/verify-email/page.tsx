import { AuthJourneyForm } from "../auth-journey-form";
import { AuthJourneyPage } from "../auth-journey-page";

export default function VerifyEmailPage() { return <AuthJourneyPage eyebrow="Xác minh" title="Xác minh email" description="Hoàn tất bước này để bảo vệ danh tính tài khoản của bạn."><AuthJourneyForm journey="verify" /></AuthJourneyPage>; }
