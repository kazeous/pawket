import { NotificationError } from "./policy.js";
import type { NotificationCategory, NotificationKind } from "./catalog.js";

// Every notice string lives here so the owner copy audit edits one file. All copy is Vietnamese, one line per field,
// and never contains dates, amounts, names, quoted content or blame wording. Deadlines are described in words
// ("trước hạn ghi trên trang") because the real deadline is shown on the page and can move when a clock pauses.
export type NoticeText = Readonly<{ title: string; body: string; actionLabel: string }>;

const notice = (title: string, body: string, actionLabel: string): NoticeText => ({ title, body, actionLabel });

const KIND_COPY: Readonly<Record<NotificationKind, NoticeText>> = {
  order_requested: notice("Có yêu cầu đặt vẽ mới", "Một người mua vừa gửi yêu cầu cho bạn. Hãy xem và phản hồi trước hạn ghi trên trang.", "Xem yêu cầu"),
  order_quoted: notice("Bạn nhận được báo giá", "Creator đã gửi báo giá cho yêu cầu của bạn. Hãy xem và trả lời trước hạn ghi trên trang.", "Xem báo giá"),
  order_payment_due: notice("Đơn đặt vẽ đang chờ thanh toán", "Hãy xem hướng dẫn chuyển khoản và hoàn tất trước hạn ghi trên trang.", "Xem hướng dẫn thanh toán"),
  order_transfer_claimed: notice("Người mua báo đã chuyển khoản", "Hãy đối chiếu với giao dịch thực nhận trong ngân hàng rồi xác nhận trên trang đơn.", "Xem đơn"),
  order_in_progress: notice("Đơn đặt vẽ đã bắt đầu thực hiện", "Thanh toán đã được ghi nhận và công việc bắt đầu. Bạn có thể theo dõi tiến độ trên trang đơn.", "Xem đơn"),
  order_delivered: notice("Bản giao cuối đã sẵn sàng", "Hãy xem bản giao và xác nhận hoặc phản hồi trước khi hết thời gian xem lại ghi trên trang.", "Xem bản giao"),
  order_completed: notice("Đơn đặt vẽ đã hoàn tất", "Đơn đã được ghi nhận là hoàn tất. Bạn có thể xem lại chi tiết bất cứ lúc nào.", "Xem đơn"),
  order_closed: notice("Đơn đặt vẽ đã đóng", "Đơn đã kết thúc và không tiếp tục. Mở trang đơn để xem lý do và các bước tiếp theo, nếu có.", "Xem đơn"),
  order_messages: notice("Có tin nhắn mới trong đơn đặt vẽ", "Bạn có tin nhắn chưa đọc. Mở đơn để xem và trả lời.", "Xem tin nhắn"),
  draft_sent: notice("Creator đã gửi bản nháp", "Hãy xem bản nháp và phản hồi để creator biết bước tiếp theo.", "Xem bản nháp"),
  draft_responded: notice("Người mua đã phản hồi bản nháp", "Mở đơn để xem phản hồi và tiếp tục công việc.", "Xem phản hồi"),
  proposal_received: notice("Bạn nhận được một đề xuất", "Hãy xem đề xuất và trả lời trước hạn ghi trên trang. Nếu không trả lời, đề xuất sẽ hết hiệu lực.", "Xem đề xuất"),
  proposal_ended: notice("Đề xuất đã kết thúc", "Đề xuất không còn hiệu lực. Mở trang đơn để xem kết quả.", "Xem đơn"),
  dispute_opened: notice("Có khiếu nại cần bạn trả lời", "Hãy xem nội dung khiếu nại và gửi ý kiến của bạn trước hạn ghi trên trang.", "Xem khiếu nại"),
  dispute_statement: notice("Có ý kiến mới trong khiếu nại", "Mở trang khiếu nại để xem ý kiến mới.", "Xem khiếu nại"),
  dispute_closed: notice("Khiếu nại đã đóng", "Mở trang để xem kết quả và các bước tiếp theo.", "Xem kết quả"),
  ruling_recorded: notice("Pawket đã ghi nhận quyết định", "Hãy xem quyết định và các bước tiếp theo trên trang.", "Xem quyết định"),
  ruling_corrected: notice("Quyết định đã được chỉnh lại", "Hãy xem nội dung cập nhật và các bước tiếp theo trên trang.", "Xem quyết định"),
  late_claim_filed: notice("Có yêu cầu về thanh toán đến muộn", "Người mua đề nghị xem xét một khoản thanh toán đến muộn. Hãy kiểm tra ngân hàng và trả lời trước hạn ghi trên trang.", "Xem yêu cầu"),
  late_claim_ended: notice("Yêu cầu về thanh toán đến muộn đã kết thúc", "Mở trang đơn để xem kết quả và các bước tiếp theo.", "Xem đơn"),
  refund_account_needed: notice("Cần nhập tài khoản nhận hoàn tiền", "Hãy nhập tài khoản nhận tiền trên trang hoàn tiền trước hạn ghi trên trang.", "Nhập tài khoản nhận"),
  refund_owed: notice("Có một khoản hoàn tiền cần thực hiện", "Người mua sẽ nhập tài khoản nhận tiền. Bạn sẽ được báo khi đến lượt bạn gửi hoàn tiền.", "Xem hoàn tiền"),
  refund_send_due: notice("Đến lượt bạn gửi hoàn tiền", "Tài khoản nhận đã được nhập. Hãy chuyển khoản và ghi nhận trên trang trước hạn ghi trên trang.", "Xem hoàn tiền"),
  refund_sent: notice("Creator đã ghi nhận gửi hoàn tiền", "Hãy kiểm tra tài khoản và xác nhận đã nhận hay chưa trước hạn ghi trên trang. Nếu không phản hồi, khoản hoàn sẽ được xem là đã nhận.", "Xác nhận đã nhận"),
  refund_not_received: notice("Người mua báo chưa nhận được hoàn tiền", "Hãy kiểm tra lại giao dịch và xem hướng dẫn trên trang.", "Xem hoàn tiền"),
  refund_resend_required: notice("Cần gửi lại hoàn tiền", "Khoản hoàn cần được gửi lại. Hãy gửi và ghi nhận trên trang trước hạn ghi trên trang.", "Xem hoàn tiền"),
  refund_settled: notice("Hoàn tiền đã được giải quyết", "Khoản hoàn đã được ghi nhận là hoàn tất. Mở trang để xem chi tiết.", "Xem hoàn tiền"),
  refund_overdue: notice("Hoàn tiền đã quá hạn", "Việc này đã được chuyển sang xử lý ưu tiên. Mở trang để xem bước tiếp theo.", "Xem hoàn tiền"),
  content_hidden: notice("Một nội dung của bạn đã được ẩn", "Nội dung tạm thời không hiển thị công khai. Bạn có thể xem chi tiết và gửi kháng nghị trong 14 ngày.", "Xem và kháng nghị"),
  content_restored: notice("Nội dung của bạn đã hiển thị lại", "Nội dung đã được khôi phục. Bạn không cần làm gì thêm.", "Xem thông báo"),
  penalty_applied: notice("Có thông báo về tài khoản của bạn", "Pawket đã áp dụng một biện pháp cho tài khoản. Bạn có thể xem chi tiết và gửi kháng nghị trong 14 ngày.", "Xem và kháng nghị"),
  penalty_ended: notice("Biện pháp trên tài khoản đã kết thúc", "Tài khoản của bạn không còn chịu biện pháp này.", "Xem thông báo"),
  appeal_received: notice("Pawket đã nhận kháng nghị của bạn", "Kháng nghị sẽ được xem xét. Bạn sẽ được báo khi có quyết định.", "Xem kháng nghị"),
  appeal_decided: notice("Kháng nghị của bạn đã có quyết định", "Mở trang để xem quyết định.", "Xem quyết định"),
  report_received: notice("Pawket đã nhận báo cáo của bạn", "Báo cáo sẽ được xem xét. Bạn sẽ được báo khi việc này được xử lý.", "Xem báo cáo"),
  report_closed: notice("Báo cáo của bạn đã được xử lý", "Cảm ơn bạn đã báo cáo. Pawket không chia sẻ chi tiết về cách xử lý.", "Xem báo cáo"),
  owner_case_opened: notice("Có việc mới trong hàng chờ", "Một mục mới đang chờ xem xét. Mở hàng chờ để xử lý.", "Mở hàng chờ"),
  tip_status: notice("Có cập nhật về tip của bạn", "Trạng thái tip đã thay đổi. Mở danh sách để xem; Pawket chỉ đối chiếu với giao dịch thực nhận trong ngân hàng.", "Mở danh sách tip"),
  tip_transfer_claimed: notice("Người ủng hộ báo đã chuyển tip", "Hãy kiểm tra ngân hàng và xác nhận khi đã nhận được tiền.", "Xem tip"),
  account_application: notice("Hồ sơ creator có cập nhật", "Mở trang hồ sơ để xem trạng thái và hướng dẫn tiếp theo.", "Xem hồ sơ"),
  account_creator_status: notice("Quyền creator có cập nhật", "Mở trang để xem trạng thái hiện tại.", "Xem trạng thái"),
  account_deposit_refund: notice("Hoàn khoản xác minh có cập nhật", "Mở trang hồ sơ để xem trạng thái hiện tại.", "Xem trạng thái"),
  reminder_due: notice("Sắp đến hạn xử lý", "Còn khoảng 24 giờ để hoàn tất việc này. Mở trang để xem và xử lý.", "Xem và xử lý"),
  deadline_missed: notice("Đã quá hạn xử lý", "Một hạn xử lý đã qua. Mở trang để xem điều gì diễn ra tiếp theo.", "Xem chi tiết"),
};

type VariantCopy = Readonly<Partial<Record<NotificationKind, Readonly<Record<string, Partial<NoticeText>>>>>>;

const reminderTask = (task: string): Partial<NoticeText> => ({ body: `Còn khoảng 24 giờ để ${task}. Mở trang để xem và xử lý.` });

// Variants are closed enums chosen by the materializer (close reason, clock, tip state, case kind, penalty type).
// A variant without an entry here falls back to the plain kind text.
const VARIANT_COPY: VariantCopy = {
  // The draft variant uses the plain kind text; a response to the final delivery speaks of the final delivery (R9).
  draft_responded: {
    final: { title: "Người mua đã phản hồi bản giao cuối", body: "Mở đơn để xem phản hồi về bản giao cuối và các bước tiếp theo." },
  },
  order_closed: {
    request_expired: { title: "Yêu cầu đặt vẽ đã hết hạn", body: "Yêu cầu không được trả lời kịp nên đơn đã đóng." },
    quote_expired: { title: "Báo giá đã hết hạn", body: "Báo giá không được trả lời kịp nên đơn đã đóng." },
    payment_expired: { title: "Đơn đã đóng vì hết hạn thanh toán", body: "Thanh toán chưa được ghi nhận kịp nên đơn đã đóng. Mở trang đơn để xem chi tiết." },
    buyer_withdrawn: { title: "Người mua đã rút yêu cầu", body: "Đơn đã đóng theo yêu cầu của người mua." },
    creator_declined: { title: "Creator đã từ chối yêu cầu", body: "Đơn đã đóng vì creator không nhận yêu cầu này." },
    quote_withdrawn: { title: "Creator đã rút báo giá", body: "Đơn đã đóng vì báo giá được rút lại." },
    quote_declined: { title: "Người mua đã từ chối báo giá", body: "Đơn đã đóng vì báo giá không được chấp nhận." },
    buyer_cancelled: { title: "Người mua đã hủy đơn", body: "Đơn đã đóng theo yêu cầu của người mua. Mở trang đơn để xem các bước tiếp theo, nếu có." },
    creator_cancelled: { title: "Creator đã hủy đơn", body: "Đơn đã đóng theo yêu cầu của creator. Mở trang đơn để xem các bước tiếp theo, nếu có." },
    cancelled_by_agreement: { title: "Đơn đã đóng theo thỏa thuận", body: "Hai bên đã thống nhất đóng đơn. Mở trang đơn để xem các bước tiếp theo, nếu có." },
    cancelled_by_ruling: { title: "Đơn đã đóng theo quyết định", body: "Đơn đã đóng theo quyết định của Pawket. Mở trang đơn để xem các bước tiếp theo." },
    fulfillment_frozen: { title: "Đơn đã đóng do tạm dừng thực hiện", body: "Việc thực hiện đơn đã được tạm dừng nên đơn đã đóng. Mở trang đơn để xem các bước tiếp theo." },
  },
  penalty_applied: {
    warning: { title: "Bạn nhận được một lời nhắc từ Pawket", body: "Hãy xem chi tiết trên trang.", actionLabel: "Xem thông báo" },
    restriction: { title: "Một số tính năng của bạn bị hạn chế", body: "Hãy xem chi tiết. Bạn có thể gửi kháng nghị trong 14 ngày." },
    suspension: { title: "Tài khoản của bạn đã bị tạm khóa", body: "Email về việc này đã được gửi riêng cho bạn, kèm hướng dẫn kháng nghị." },
    removal: { title: "Tài khoản của bạn đã bị đóng", body: "Email về việc này đã được gửi riêng cho bạn, kèm hướng dẫn kháng nghị." },
  },
  owner_case_opened: {
    dispute: { title: "Có khiếu nại mới trong hàng chờ" },
    refund_not_received: { title: "Có báo cáo chưa nhận hoàn tiền trong hàng chờ" },
    refund_overdue: { title: "Có hoàn tiền quá hạn trong hàng chờ" },
    late_payment: { title: "Có yêu cầu thanh toán đến muộn trong hàng chờ" },
    report: { title: "Có báo cáo mới trong hàng chờ" },
    appeal: { title: "Có kháng nghị mới trong hàng chờ" },
  },
  tip_status: {
    created: { title: "Có yêu cầu tip mới", body: "Đây chưa phải xác nhận tiền đã vào ngân hàng. Mở danh sách để xem trạng thái." },
    confirmed: { title: "Tip đã được xác nhận", body: "Pawket đã ghi nhận thao tác xác nhận tip thủ công của bạn." },
    expired: { title: "Một yêu cầu tip đã hết hạn", body: "Trạng thái này không cho biết tiền có đến ngân hàng hay chưa." },
  },
  reminder_due: {
    request_response: reminderTask("trả lời yêu cầu đặt vẽ"),
    quote_acceptance: reminderTask("trả lời báo giá"),
    payment: reminderTask("hoàn tất thanh toán"),
    delivery_due: reminderTask("giao bản vẽ"),
    review_window: reminderTask("xem và xác nhận bản giao"),
    proposal_response: reminderTask("trả lời đề xuất"),
    dispute_response: reminderTask("gửi ý kiến về khiếu nại"),
    late_claim_response: reminderTask("trả lời yêu cầu về thanh toán đến muộn"),
    refund_send: reminderTask("gửi hoàn tiền"),
    refund_confirm: reminderTask("xác nhận đã nhận hoàn tiền"),
    appeal_window: reminderTask("gửi kháng nghị"),
  },
  deadline_missed: {
    delivery_due: { title: "Đơn đã quá hạn giao", body: "Hạn giao bản vẽ đã qua. Mở trang đơn để xem các bước tiếp theo." },
    dispute_response: { title: "Hạn trả lời khiếu nại đã qua", body: "Mở trang khiếu nại để xem bước tiếp theo." },
  },
};

export function renderNotice(kind: NotificationKind, variant: string | null): NoticeText {
  const base = Object.hasOwn(KIND_COPY, kind) ? KIND_COPY[kind] : undefined;
  if (!base) throw new NotificationError("invalid_request");
  const override = variant !== null && Object.hasOwn(VARIANT_COPY[kind] ?? {}, variant) ? VARIANT_COPY[kind]?.[variant] : undefined;
  return override ? { ...base, ...override } : { ...base };
}

const CATEGORY_SUBJECTS: Readonly<Record<Exclude<NotificationCategory, "account">, string>> = {
  orders: "Cập nhật đơn đặt vẽ trên Pawket",
  messages: "Tin nhắn mới trên Pawket",
  deliveries: "Cập nhật bản nháp trên Pawket",
  disputes_refunds: "Cập nhật khiếu nại hoặc hoàn tiền trên Pawket",
  moderation: "Thông báo kiểm duyệt Pawket",
  owner_queue: "Có việc mới trong hàng chờ Pawket",
  tips: "Cập nhật tip Pawket",
};

// Account notices are in-app only (their emails already exist), so no notification email subject exists for them.
export function subjectForCategory(category: NotificationCategory): string {
  if (!Object.hasOwn(CATEGORY_SUBJECTS, category)) throw new NotificationError("invalid_request");
  return CATEGORY_SUBJECTS[category as keyof typeof CATEGORY_SUBJECTS];
}

// Footer and email framing for notification emails; kept beside the notice copy for the copy audit.
export const NOTIFICATION_EMAIL_COPY = Object.freeze({
  actionIntro: "Mở thông báo trên Pawket:",
  manageLabel: "Quản lý thông báo",
});
