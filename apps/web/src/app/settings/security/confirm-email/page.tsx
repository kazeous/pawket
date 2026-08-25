import { AuthJourneyForm } from "../../../auth-journey-form";
import { AuthJourneyPage } from "../../../auth-journey-page";

export default function ConfirmEmailPage() { return <AuthJourneyPage eyebrow="Bảo mật" title="Xác nhận email mới" description="Bạn cần đang đăng nhập để hoàn tất thay đổi nhạy cảm này."><AuthJourneyForm journey="confirm-email" /></AuthJourneyPage>; }
