import { AuthJourneyForm } from "../../auth-journey-form";
import { AuthJourneyPage } from "../../auth-journey-page";

export default function ResendVerificationPage() { return <AuthJourneyPage eyebrow="Xác minh" title="Gửi lại email xác minh" description="Dùng khi liên kết cũ đã hết hạn hoặc email chưa tới."><AuthJourneyForm journey="resend" /></AuthJourneyPage>; }
