import {
  DeterministicLocalSecurityEmailSink,
  DisabledSecurityEmailSender,
  type SecurityEmailMessage,
  type SecurityEmailSender,
} from "@pawket/identity/security-email";

import {
  renderSecurityEmailHtml,
  renderSecurityEmailText,
  type SecurityEmailContent,
} from "./security-email-html.js";

export type SmtpSecurityEmailConfig = Readonly<{
  host: string;
  port: number;
  tlsMode: "starttls" | "tls";
  username: string;
  password: string;
  fromEmail: string;
  fromName: string;
}>;

export type SmtpTransportOptions = Readonly<{
  host: string;
  port: number;
  secure: boolean;
  requireTLS?: boolean;
  auth: Readonly<{ user: string; pass: string }>;
}>;

export type SmtpMail = Readonly<{
  from: Readonly<{ name: string; address: string }>;
  to: string;
  subject: string;
  text: string;
  html: string;
}>;

export type SmtpTransport = {
  sendMail(message: SmtpMail): Promise<unknown>;
};

export type SmtpTransportFactory = (options: SmtpTransportOptions) => SmtpTransport;

export type SecurityEmailEnvironment = Readonly<{
  APP_BASE_URL: string;
  SECURITY_EMAIL_ADAPTER: "disabled" | "local" | "smtp";
  SMTP_HOST?: string;
  SMTP_PORT?: number;
  SMTP_TLS_MODE?: "starttls" | "tls";
  SMTP_USERNAME?: string;
  SMTP_PASSWORD?: string;
  SMTP_FROM_EMAIL?: string;
  SMTP_FROM_NAME?: string;
}>;

function isCompleteSmtpConfig(
  config: Partial<SmtpSecurityEmailConfig> | undefined,
): config is SmtpSecurityEmailConfig {
  return Boolean(
    config &&
      typeof config.host === "string" &&
      config.host.length > 0 &&
      Number.isInteger(config.port) &&
      config.port !== undefined &&
      config.port >= 1 &&
      config.port <= 65_535 &&
      (config.tlsMode === "starttls" || config.tlsMode === "tls") &&
      typeof config.username === "string" &&
      config.username.length > 0 &&
      typeof config.password === "string" &&
      config.password.length > 0 &&
      typeof config.fromEmail === "string" &&
      config.fromEmail.length > 0 &&
      typeof config.fromName === "string" &&
      config.fromName.length > 0,
  );
}

function subjectFor(purpose: SecurityEmailMessage["purpose"]): string {
  switch (purpose) {
    case "email_verification":
    case "password_reset":
    case "email_change":
      throw new Error("AUTH_MOVED");
    case "security_notice":
      return "Thông báo bảo mật Pawket";
    case "application_outcome":
      return "Cập nhật hồ sơ creator Pawket";
    case "creator_status":
      return "Cập nhật quyền creator Pawket";
    case "refund_status":
      return "Cập nhật hoàn khoản xác minh Pawket";
    case "tip_status":
      return "Cập nhật tip Pawket";
  }
}

function noticeContent(event: string | undefined): SecurityEmailContent {
  const notices: Record<string, string> = {
    password_changed: "Mật khẩu Pawket của bạn đã được thay đổi.",
    primary_email_changed: "Email chính của tài khoản Pawket đã được thay đổi.",
    recovery_codes_regenerated: "Bộ mã khôi phục Pawket đã được tạo lại.",
    recovery_code_used_factor_reset_required:
      "Một mã khôi phục Pawket vừa được dùng. Các phiên khác đã bị thu hồi và bạn cần thiết lập lại bước xác thực.",
    session_revoked: "Một phiên đăng nhập Pawket đã được thu hồi.",
    sessions_revoked: "Tất cả phiên đăng nhập Pawket đã được thu hồi.",
    social_identity_linked: "Một danh tính đăng nhập bên ngoài đã được liên kết với Pawket.",
    social_identity_unlinked: "Một danh tính đăng nhập bên ngoài đã được gỡ khỏi Pawket.",
    totp_enrolled: "Ứng dụng xác thực TOTP đã được thiết lập cho Pawket.",
    owner_bootstrap_completed:
      "Quyền owner Pawket đã được khởi tạo. Bạn cần thiết lập TOTP trước khi thực hiện thao tác owner.",
    owner_mfa_break_glass_completed:
      "Khôi phục MFA khẩn cấp cho owner đã hoàn tất. Tất cả phiên và yếu tố cũ đã bị vô hiệu hóa; hãy đăng nhập và thiết lập TOTP mới ngay.",
  };
  const eventText = event && Object.hasOwn(notices, event) ? notices[event] : undefined;
  if (!eventText) throw new Error("Invalid security email message");
  // Security notices deliberately carry no call-to-action link.
  return {
    heading: "Thông báo bảo mật Pawket",
    paragraphs: [eventText, "Nếu bạn không thực hiện thay đổi này, hãy liên hệ hỗ trợ Pawket ngay."],
  };
}

function safePawketLink(appBaseUrl: string, path: string): string {
  return new URL(path, appBaseUrl).toString();
}

function applicationOutcomeContent(appBaseUrl: string, state: string | undefined): SecurityEmailContent {
  const outcomes: Record<string, string> = {
    changes_requested: "Pawket cần bạn cập nhật một số nội dung trong hồ sơ creator.",
    approved: "Hồ sơ creator của bạn đã được chấp thuận.",
    rejected: "Hồ sơ creator của bạn chưa được chấp thuận.",
    reopened: "Pawket đã mở lại hồ sơ creator để bạn tiếp tục cập nhật.",
  };
  const outcome = state && Object.hasOwn(outcomes, state) ? outcomes[state] : undefined;
  if (!outcome) throw new Error("Invalid security email message");
  return {
    heading: "Cập nhật hồ sơ creator Pawket",
    paragraphs: [outcome],
    action: {
      intro: "Xem trạng thái và hướng dẫn tiếp theo:",
      label: "Xem trạng thái và hướng dẫn",
      url: safePawketLink(appBaseUrl, "/creator/apply"),
    },
  };
}

function creatorStatusContent(appBaseUrl: string, state: string | undefined): SecurityEmailContent {
  const status =
    state === "active"
      ? "Quyền creator Pawket của bạn đang hoạt động."
      : state === "suspended"
        ? "Quyền creator Pawket của bạn đã bị tạm ngưng."
        : undefined;
  if (!status) throw new Error("Invalid security email message");
  return {
    heading: "Cập nhật quyền creator Pawket",
    paragraphs: [status],
    action: { intro: "Xem trạng thái:", label: "Xem trạng thái", url: safePawketLink(appBaseUrl, "/creator") },
  };
}

function refundStatusContent(
  appBaseUrl: string,
  data: Readonly<Record<string, string>>,
): SecurityEmailContent {
  const statuses: Record<string, string> = {
    pending_window: "Pawket đã ghi nhận nghĩa vụ hoàn khoản xác minh về đúng tài khoản đã chứng minh.",
    ready: "Khoản hoàn xác minh đã bước vào thời gian xử lý.",
    due_today: "Hôm nay là ngày đến hạn hoàn khoản xác minh.",
    overdue: "Khoản hoàn xác minh đã quá hạn và được chuyển sang xử lý ưu tiên.",
    sent: "Pawket đã ghi nhận khoản hoàn xác minh là đã gửi.",
    attention_required: "Khoản hoàn xác minh cần được Pawket xử lý thêm.",
  };
  const status = data.state && Object.hasOwn(statuses, data.state) ? statuses[data.state] : undefined;
  if (!status || !/^\d{4}-\d{2}-\d{2}$/u.test(data.refundNotBefore ?? "") || !/^\d{4}-\d{2}-\d{2}$/u.test(data.refundDue ?? "")) {
    throw new Error("Invalid security email message");
  }
  return {
    heading: "Cập nhật hoàn khoản xác minh Pawket",
    paragraphs: [status],
    detail: { label: "Khung hoàn đã ghi nhận", value: `${data.refundNotBefore} đến ${data.refundDue}` },
    action: { intro: "Xem trạng thái:", label: "Xem trạng thái", url: safePawketLink(appBaseUrl, "/creator/apply") },
  };
}

function tipStatusContent(appBaseUrl: string, message: SecurityEmailMessage): SecurityEmailContent {
  const states: Record<string, string> = {
    created: "Có yêu cầu tip mới trong lịch sử của bạn. Đây chưa phải xác nhận tiền đã vào ngân hàng.",
    confirmed: "Pawket đã ghi nhận thao tác xác nhận tip thủ công của bạn.",
    expired: "Một yêu cầu tip đã hết thời hạn chuyển khoản trên Pawket. Trạng thái này không xác định tiền có đến ngân hàng hay chưa.",
  };
  if (message.secret !== null || !Object.hasOwn(states, message.templateData.state ?? "") || Object.keys(message.templateData).sort().join() !== "returnPath,state" || message.templateData.returnPath !== "/creator/tips") throw new Error("Invalid security email message");
  return {
    heading: "Cập nhật tip Pawket",
    paragraphs: [states[message.templateData.state!]!],
    action: {
      intro: "Mở danh sách để xem trạng thái hiện tại. Pawket không giữ tiền tip; chỉ đối chiếu với giao dịch thực nhận trong ngân hàng.",
      label: "Mở danh sách tip",
      url: safePawketLink(appBaseUrl, "/creator/tips"),
    },
  };
}

function renderContent(appBaseUrl: string, message: SecurityEmailMessage): SecurityEmailContent {
  switch (message.purpose) {
    case "security_notice":
      return noticeContent(message.templateData.event);
    case "application_outcome":
      return applicationOutcomeContent(appBaseUrl, message.templateData.state);
    case "creator_status":
      return creatorStatusContent(appBaseUrl, message.templateData.state);
    case "refund_status":
      return refundStatusContent(appBaseUrl, message.templateData);
    case "tip_status":
      return tipStatusContent(appBaseUrl, message);
    case "email_verification":
    case "password_reset":
    case "email_change":
      throw new Error("AUTH_MOVED");
  }
}

class SmtpSecurityEmailSender implements SecurityEmailSender {
  constructor(
    private readonly appBaseUrl: string,
    private readonly from: Readonly<{ name: string; address: string }>,
    private readonly transport: SmtpTransport,
  ) {}

  async send(message: SecurityEmailMessage): Promise<void> {
    const subject = subjectFor(message.purpose);
    const content = renderContent(this.appBaseUrl, message);
    await this.transport.sendMail({
      from: this.from,
      to: message.destination,
      subject,
      text: renderSecurityEmailText(content),
      html: renderSecurityEmailHtml(this.appBaseUrl, content),
    });
  }
}

export function createSecurityEmailSender(input: {
  adapter: "disabled" | "local" | "smtp";
  appBaseUrl: string;
  smtp?: Partial<SmtpSecurityEmailConfig>;
  createTransport?: SmtpTransportFactory;
}): SecurityEmailSender {
  if (input.adapter === "local") return new DeterministicLocalSecurityEmailSink();
  if (input.adapter === "disabled") return new DisabledSecurityEmailSender();

  if (!isCompleteSmtpConfig(input.smtp) || !input.createTransport) {
    throw new Error("Invalid SMTP security email configuration");
  }

  const transport = input.createTransport({
    host: input.smtp.host,
    port: input.smtp.port,
    secure: input.smtp.tlsMode === "tls",
    ...(input.smtp.tlsMode === "starttls" ? { requireTLS: true } : {}),
    auth: { user: input.smtp.username, pass: input.smtp.password },
  });

  return new SmtpSecurityEmailSender(
    input.appBaseUrl,
    { name: input.smtp.fromName, address: input.smtp.fromEmail },
    transport,
  );
}

export function createSecurityEmailSenderFromEnv(input: {
  env: SecurityEmailEnvironment;
  createTransport?: SmtpTransportFactory;
}): SecurityEmailSender {
  return createSecurityEmailSender({
    adapter: input.env.SECURITY_EMAIL_ADAPTER,
    appBaseUrl: input.env.APP_BASE_URL,
    smtp: {
      host: input.env.SMTP_HOST,
      port: input.env.SMTP_PORT,
      tlsMode: input.env.SMTP_TLS_MODE,
      username: input.env.SMTP_USERNAME,
      password: input.env.SMTP_PASSWORD,
      fromEmail: input.env.SMTP_FROM_EMAIL,
      fromName: input.env.SMTP_FROM_NAME,
    },
    createTransport: input.createTransport,
  });
}
