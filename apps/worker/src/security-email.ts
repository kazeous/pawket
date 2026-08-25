import {
  DeterministicLocalSecurityEmailSink,
  DisabledSecurityEmailSender,
  type SecurityEmailMessage,
  type SecurityEmailSender,
} from "@pawket/identity/security-email";

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

function challengePath(purpose: SecurityEmailMessage["purpose"]): string | null {
  switch (purpose) {
    case "email_verification":
      return "/verify-email";
    case "email_change":
      return "/settings/security/confirm-email";
    case "password_reset":
      return "/reset-password";
    case "security_notice":
      return null;
  }
}

function subjectFor(purpose: SecurityEmailMessage["purpose"]): string {
  switch (purpose) {
    case "email_verification":
      return "Verify your Pawket email";
    case "password_reset":
      return "Reset your Pawket password";
    case "email_change":
      return "Confirm your new Pawket email";
    case "security_notice":
      return "Pawket security notice";
  }
}

function noticeText(event: string | undefined): string {
  const eventText =
    event === "primary_email_changed"
      ? "Your primary Pawket email was changed."
      : "Your Pawket password was changed.";
  return `Pawket security notice\n\n${eventText} If this was not you, contact Pawket support immediately.`;
}

function renderText(appBaseUrl: string, message: SecurityEmailMessage): string {
  const path = challengePath(message.purpose);
  if (path === null) return noticeText(message.templateData.event);
  if (!message.secret) throw new Error("Invalid security email message");

  const link = new URL(path, appBaseUrl);
  link.searchParams.set("token", message.secret);
  return (
    `${subjectFor(message.purpose)}\n\n` +
    "Open this Pawket link to continue:\n" +
    `${link.toString()}\n\n` +
    "This link expires in 30 minutes. If you did not request this, you can ignore this email."
  );
}

class SmtpSecurityEmailSender implements SecurityEmailSender {
  constructor(
    private readonly appBaseUrl: string,
    private readonly from: Readonly<{ name: string; address: string }>,
    private readonly transport: SmtpTransport,
  ) {}

  async send(message: SecurityEmailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: message.destination,
      subject: subjectFor(message.purpose),
      text: renderText(this.appBaseUrl, message),
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
