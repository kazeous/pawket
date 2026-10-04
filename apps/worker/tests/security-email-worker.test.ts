import { EventEmitter } from "node:events";

import { afterEach, describe, expect, test, vi } from "vitest";

import { metricsRegistry } from "@pawket/observability";

import {
  createSecurityEmailSender,
  createSecurityEmailSenderFromEnv,
  type SmtpMail,
  type SmtpTransportOptions,
} from "../src/security-email.js";
import { renderSecurityEmailHtml } from "../src/security-email-html.js";
import * as workerRuntime from "../src/worker-runtime.js";

type ProcessorFactory = {
  createWorkerJobProcessor(input: {
    logger: { info(data: Record<string, unknown>, message?: string): void; error(data: Record<string, unknown>, message?: string): void };
    database: never;
    acknowledge: (db: never, input: { eventId: string }) => Promise<boolean>;
    securityEmail?: {
      keyring: never;
      sender: never;
      deliver: (db: never, input: Record<string, unknown>) => Promise<
        "delivered" | "already_delivered" | "attention_required" | "already_attention_required"
      >;
      materialize?: (input: Record<string, unknown>) => Promise<"created" | "attention_required" | "already_materialized">;
    };
  }): (job: unknown) => Promise<void>;
};

const runtime = workerRuntime as unknown as Partial<ProcessorFactory>;

function job(eventType: string, payload: Record<string, unknown>) {
  return {
    id: "42b386d6-c7f1-4d11-a3c9-97ac728285c3",
    name: "system.outbox-event",
    data: {
      outboxEventId: "42b386d6-c7f1-4d11-a3c9-97ac728285c3",
      eventType,
      eventVersion: 1,
      aggregateType: "security_email_handoff",
      aggregateId: "9fed3abd-ec32-462b-ad0b-366babf979c3",
      payload,
      occurredAt: "2026-08-24T04:00:00.000Z",
    },
  };
}

async function scanHealth(scan: string): Promise<number> {
  const metric = metricsRegistry.getSingleMetric("pawket_worker_scan_healthy");
  if (!metric) throw new Error("Worker scan-health metric is not registered");
  const snapshot = await metric.get();
  return snapshot.values.find((value) => value.labels.scan === scan)?.value ?? -1;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("security email worker contract", () => {
  test("materializes Payments liability email before acknowledging without moving funds", async () => {
    const calls: string[] = [];
    const acknowledge = vi.fn(async () => {
      calls.push("acknowledge");
      return true;
    });
    const materialize = vi.fn(async () => {
      calls.push("materialize");
      return "created" as const;
    });
    const processor = runtime.createWorkerJobProcessor!({
      logger: { info() {}, error() {} },
      database: {} as never,
      acknowledge,
      securityEmail: {
        keyring: {} as never,
        sender: {} as never,
        deliver: vi.fn(async () => "delivered" as const),
        materialize,
      },
    });
    await expect(
      processor(
        job("payments.verification_deposit_refund_due_today.v1", {
          obligationId: "9fed3abd-ec32-462b-ad0b-366babf979c3",
          state: "ready",
        }),
      ),
    ).resolves.toBeUndefined();
    expect(calls).toEqual(["materialize", "acknowledge"]);
    expect(materialize).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          eventType: "payments.verification_deposit_refund_due_today.v1",
        }),
      }),
    );
    expect(acknowledge).toHaveBeenCalledOnce();
  });

  test("delivers the purpose-bound handoff before acknowledging the outbox event", async () => {
    expect(typeof runtime.createWorkerJobProcessor).toBe("function");
    const calls: string[] = [];
    const deliver = vi.fn(async () => {
      calls.push("deliver");
      return "delivered" as const;
    });
    const acknowledge = vi.fn(async () => {
      calls.push("acknowledge");
      return true;
    });
    const processor = runtime.createWorkerJobProcessor!({
      logger: { info() {}, error() {} },
      database: {} as never,
      acknowledge,
      securityEmail: { keyring: {} as never, sender: {} as never, deliver },
    });

    await expect(
      processor(
        job("identity.security_email.requested.v1", {
          handoffId: "9fed3abd-ec32-462b-ad0b-366babf979c3",
          purpose: "password_reset",
        }),
      ),
    ).resolves.toBeUndefined();
    expect(calls).toEqual(["deliver", "acknowledge"]);
    expect(deliver).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        handoffId: "9fed3abd-ec32-462b-ad0b-366babf979c3",
        workerId: "42b386d6-c7f1-4d11-a3c9-97ac728285c3",
      }),
    );
  });

  test("records a fresh bounded terminal outcome once while acknowledging its replay", async () => {
    // Break caught: exhausting SMTP uncertainty by rethrowing forever instead of surfacing durable attention.
    metricsRegistry.resetMetrics();
    const calls: string[] = [];
    let invocation = 0;
    const deliver = vi.fn(async () => {
      calls.push("deliver");
      invocation += 1;
      return invocation === 1
        ? ("attention_required" as const)
        : ("already_attention_required" as const);
    });
    const acknowledge = vi.fn(async () => {
      calls.push("acknowledge");
      return true;
    });
    const processor = runtime.createWorkerJobProcessor!({
      logger: { info() {}, error() {} },
      database: {} as never,
      acknowledge,
      securityEmail: { keyring: {} as never, sender: {} as never, deliver },
    });

    await expect(
      processor(
        job("identity.security_email.requested.v1", {
          handoffId: "9fed3abd-ec32-462b-ad0b-366babf979c3",
          purpose: "password_reset",
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      processor(
        job("identity.security_email.requested.v1", {
          handoffId: "9fed3abd-ec32-462b-ad0b-366babf979c3",
          purpose: "password_reset",
        }),
      ),
    ).resolves.toBeUndefined();

    expect(calls).toEqual(["deliver", "acknowledge", "deliver", "acknowledge"]);
    expect(await metricsRegistry.metrics()).toContain(
      'pawket_security_emails_total{purpose="password_reset",outcome="attention_required"} 1',
    );
  });

  test("fails closed without delivery configuration and never acknowledges", async () => {
    const acknowledge = vi.fn(async () => true);
    const processor = runtime.createWorkerJobProcessor!({
      logger: { info() {}, error() {} },
      database: {} as never,
      acknowledge,
    });
    await expect(
      processor(
        job("identity.security_email.requested.v1", {
          handoffId: "9fed3abd-ec32-462b-ad0b-366babf979c3",
          purpose: "password_reset",
        }),
      ),
    ).rejects.toThrow("Security email delivery unavailable");
    expect(acknowledge).not.toHaveBeenCalled();
  });

  test("rejects a mismatched handoff payload without reflecting payload values", async () => {
    const processor = runtime.createWorkerJobProcessor!({
      logger: { info() {}, error() {} },
      database: {} as never,
      acknowledge: vi.fn(async () => true),
      securityEmail: {
        keyring: {} as never,
        sender: {} as never,
        deliver: vi.fn(async () => "delivered" as const),
      },
    });
    await expect(
      processor(
        job("identity.security_email.requested.v1", {
          handoffId: "00000000-0000-4000-8000-000000000000",
          purpose: "password_reset",
        }),
      ),
    ).rejects.toThrow("Invalid security email job");
  });
});

describe("production SMTP security email sender", () => {
  const smtp = {
    host: "smtp.transactional.example",
    port: 587,
    tlsMode: "starttls" as const,
    username: "pawket-production",
    password: "smtp-password-that-must-not-leak",
    fromEmail: "security@pawket.example",
    fromName: "Pawket Security",
  };

  test("requires STARTTLS and sends a purpose-bound session security notice", async () => {
    // Business/security notices retain their SMTP guarantees after SSO retirement.
    let transportOptions: SmtpTransportOptions | undefined;
    let delivered: SmtpMail | undefined;
    const sender = createSecurityEmailSender({
      adapter: "smtp",
      appBaseUrl: "https://pawket.example",
      smtp,
      createTransport(options) {
        transportOptions = options;
        return {
          async sendMail(message) {
            delivered = message;
            return { accepted: [message.to] };
          },
        };
      },
    });

    await sender.send({
      handoffId: "6c81afe1-1704-4653-a7a8-89630f0c990a",
      purpose: "security_notice",
      destination: "artist@example.com",
      secret: null,
      templateData: { event: "session_revoked", returnPath: "/settings/security" },
    });

    expect(transportOptions).toEqual({
      host: "smtp.transactional.example",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: {
        user: "pawket-production",
        pass: "smtp-password-that-must-not-leak",
      },
    });
    expect(delivered).toEqual({
      from: { name: "Pawket Security", address: "security@pawket.example" },
      to: "artist@example.com",
      subject: "Thông báo bảo mật Pawket",
      text:
        "Thông báo bảo mật Pawket\n\nMột phiên đăng nhập Pawket đã được thu hồi.\n\nNếu bạn không thực hiện thay đổi này, hãy liên hệ hỗ trợ Pawket ngay.",
      html: expect.stringContaining("Một phiên đăng nhập Pawket đã được thu hồi."),
    });
  });

  test("sends a branded HTML alternative that mirrors the text body and its only link", async () => {
    // Catches the HTML part drifting from the text part or linking somewhere the text does not.
    const sent: SmtpMail[] = [];
    const sender = createSecurityEmailSender({ adapter: "smtp", appBaseUrl: "https://pawket.example", smtp,
      createTransport() { return { async sendMail(mail) { sent.push(mail); } }; } });
    const messages = [
      { purpose: "application_outcome", templateData: { state: "approved" }, path: "/creator/apply" },
      { purpose: "creator_status", templateData: { state: "active" }, path: "/creator" },
      { purpose: "refund_status", templateData: { state: "ready", refundNotBefore: "2026-09-01", refundDue: "2026-09-08" }, path: "/creator/apply" },
      { purpose: "tip_status", templateData: { state: "created", returnPath: "/creator/tips" }, path: "/creator/tips" },
    ] as const;
    for (const { purpose, templateData } of messages) {
      await sender.send({ handoffId: "synthetic-html-handoff", purpose, destination: "synthetic@example.invalid", secret: null, templateData });
    }

    expect(sent).toHaveLength(messages.length);
    sent.forEach((mail, index) => {
      expect(mail.html).toMatch(/^<!DOCTYPE html>\n<html lang="vi">/u);
      expect(mail.html).toContain(`<h1 style="margin: 0; font-size: 22px; line-height: 1.3; font-weight: bold;">${mail.subject}</h1>`);
      // The refund window renders as a label/value box (asserted below); colon lead-ins become the button.
      for (const line of mail.text.split("\n").filter((value) => value.length > 0 && !value.startsWith("Khung hoàn") && !value.endsWith(":"))) expect(mail.html).toContain(line);
      const actionUrl = `https://pawket.example${messages[index]!.path}`;
      const hrefs = [...mail.html.matchAll(/href="([^"]*)"/gu)].map((match) => match[1]);
      expect(new Set(hrefs)).toEqual(new Set([actionUrl, "https://pawket.example/"]));
    });
    expect(sent[2]?.html).toContain("2026-09-01 đến 2026-09-08");
  });

  test("security notice HTML carries no call-to-action link", async () => {
    // Catches a phishing-shaped "click here" button appearing in account security notices.
    let delivered: SmtpMail | undefined;
    const sender = createSecurityEmailSender({ adapter: "smtp", appBaseUrl: "https://pawket.example", smtp,
      createTransport() { return { async sendMail(mail) { delivered = mail; } }; } });
    await sender.send({ handoffId: "synthetic-notice", purpose: "security_notice", destination: "synthetic@example.invalid", secret: null, templateData: { event: "password_changed" } });

    const hrefs = [...(delivered?.html ?? "").matchAll(/href="([^"]*)"/gu)].map((match) => match[1]);
    expect(hrefs).toEqual(["https://pawket.example/"]);
    expect(delivered?.html).toContain("Mật khẩu Pawket của bạn đã được thay đổi.");
  });

  test("rejects inherited template keys instead of rendering prototype values", async () => {
    // Catches lookups such as notices["__proto__"] slipping past validation into the email body.
    const sendMail = vi.fn(async () => {});
    const sender = createSecurityEmailSender({ adapter: "smtp", appBaseUrl: "https://pawket.example", smtp, createTransport: () => ({ sendMail }) });
    const base = { handoffId: "synthetic-proto", destination: "synthetic@example.invalid", secret: null } as const;
    await expect(sender.send({ ...base, purpose: "security_notice", templateData: { event: "__proto__" } })).rejects.toThrow("Invalid security email message");
    await expect(sender.send({ ...base, purpose: "application_outcome", templateData: { state: "constructor" } })).rejects.toThrow("Invalid security email message");
    await expect(sender.send({ ...base, purpose: "refund_status", templateData: { state: "toString", refundNotBefore: "2026-09-01", refundDue: "2026-09-08" } })).rejects.toThrow("Invalid security email message");
    expect(sendMail).not.toHaveBeenCalled();
  });

  test("HTML renderer escapes every inserted value", () => {
    // Catches markup injection if a future template passes untrusted text into the layout.
    const html = renderSecurityEmailHtml("https://pawket.example", {
      heading: "<script>alert(1)</script>",
      paragraphs: ["a & b \"quoted\" 'single'"],
      detail: { label: "<b>label</b>", value: "<img src=x>" },
      action: { intro: "<i>intro</i>", label: "<u>go</u>", url: "https://pawket.example/x?a=1&b=\"2\"" },
    });

    expect(html).not.toMatch(/<(script|b|img|i|u)[ >]/u);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("a &amp; b &quot;quoted&quot; &#39;single&#39;");
    expect(html).toContain('href="https://pawket.example/x?a=1&amp;b=&quot;2&quot;"');
  });

  test("SMTP sender cannot emit retired credential links", async () => {
    const sendMail = vi.fn(async () => {});
    const sender = createSecurityEmailSender({ adapter: "smtp", appBaseUrl: "https://pawket.example", smtp, createTransport: () => ({ sendMail }) });
    for (const purpose of ["email_verification", "password_reset", "email_change"] as const) {
      await expect(sender.send({ handoffId: "synthetic-retired", purpose, destination: "synthetic@example.invalid", secret: "synthetic-token", templateData: {} })).rejects.toThrow("AUTH_MOVED");
    }
    expect(sendMail).not.toHaveBeenCalled();
  });

  test("uses implicit TLS when the provider requires port 465", () => {
    // Catches treating implicit TLS as plaintext or attempting STARTTLS after connection.
    let transportOptions: SmtpTransportOptions | undefined;
    createSecurityEmailSender({
      adapter: "smtp",
      appBaseUrl: "https://pawket.example",
      smtp: { ...smtp, port: 465, tlsMode: "tls" },
      createTransport(options) {
        transportOptions = options;
        return { async sendMail() {} };
      },
    });

    expect(transportOptions).toEqual({
      host: "smtp.transactional.example",
      port: 465,
      secure: true,
      auth: {
        user: "pawket-production",
        pass: "smtp-password-that-must-not-leak",
      },
    });
  });

  test("tip status templates are fixed, omit financial evidence and reject extra data", async () => {
    const sent: SmtpMail[] = [];
    const sender = createSecurityEmailSender({ adapter: "smtp", appBaseUrl: "https://pawket.example", smtp,
      createTransport() { return { async sendMail(mail) { sent.push(mail); } }; } });
    for (const state of ["created", "confirmed", "expired"]) await sender.send({ handoffId: "synthetic-tip-handoff", purpose: "tip_status", destination: "synthetic@example.invalid", secret: null, templateData: { state, returnPath: "/creator/tips" } });
    expect(sent).toHaveLength(3); for (const mail of sent) { expect(mail.subject).toBe("Cập nhật tip Pawket"); expect(mail.text).toContain("https://pawket.example/creator/tips"); expect(mail.text).toContain("Pawket không giữ tiền tip"); }
    expect(sent[0]?.text).toContain("chưa phải xác nhận tiền"); expect(sent[1]?.text).toContain("xác nhận tip thủ công"); expect(sent[2]?.text).toContain("không xác định tiền có đến ngân hàng");
    for (const templateData of [{ state: "confirmed", returnPath: "https://evil.invalid" }, { state: "confirmed", returnPath: "/creator/tips", name: "private guest" }, { state: "__proto__", returnPath: "/creator/tips" }]) {
      await expect(sender.send({ handoffId: "synthetic-tip-handoff", purpose: "tip_status", destination: "synthetic@example.invalid", secret: null, templateData })).rejects.toThrow();
    }
    expect(sent).toHaveLength(3);
  });

  test("records a retryable email failure before rethrowing a fixed safe error", async () => {
    // Catches worker retries without a bounded failure signal or leaked provider text.
    metricsRegistry.resetMetrics();
    const logs: string[] = [];
    const processor = runtime.createWorkerJobProcessor!({
      logger: {
        info() {},
        error(data, message) {
          logs.push(JSON.stringify({ data, message }));
        },
      },
      database: {} as never,
      acknowledge: vi.fn(async () => true),
      securityEmail: {
        keyring: {} as never,
        sender: {} as never,
        deliver: vi.fn(async () => {
          throw new Error("smtp://artist@example.test:secret@provider.invalid");
        }),
      },
    });

    await expect(
      processor(
        job("identity.security_email.requested.v1", {
          handoffId: "9fed3abd-ec32-462b-ad0b-366babf979c3",
          purpose: "password_reset",
        }),
      ),
    ).rejects.toThrow("Worker job processing failed");

    const snapshot = await metricsRegistry.metrics();
    expect(snapshot).toContain(
      'pawket_security_emails_total{purpose="password_reset",outcome="retryable_failure"} 1',
    );
    expect(snapshot).not.toContain("artist@example.test");
    expect(logs.join("\n")).not.toContain("artist@example.test");
    expect(logs.join("\n")).not.toContain("provider.invalid");
  });

  test("email-change security notices no longer contain a local confirmation link", async () => {
    let delivered: SmtpMail | undefined;
    const sender = createSecurityEmailSender({
      adapter: "smtp",
      appBaseUrl: "https://pawket.example",
      smtp,
      createTransport() {
        return { async sendMail(message) { delivered = message; } };
      },
    });

    await sender.send({
      handoffId: "6c81afe1-1704-4653-a7a8-89630f0c990a",
      purpose: "security_notice",
      destination: "artist-new@example.com",
      secret: null,
      templateData: { event: "primary_email_changed", returnPath: "/settings/security" },
    });

    expect(delivered?.text).toContain("Email chính của tài khoản Pawket đã được thay đổi.");
    expect(delivered?.text).not.toContain("confirm-email");
    expect(delivered?.text).not.toContain("https://pawket.example/verify-email?");
  });

  test.each([
    ["application_outcome", { state: "approved" }, "Hồ sơ creator của bạn đã được chấp thuận", "/creator/apply"],
    ["creator_status", { state: "suspended" }, "đã bị tạm ngưng", "/creator"],
    [
      "refund_status",
      { state: "due_today", refundNotBefore: "2026-08-30", refundDue: "2026-09-02" },
      "Hôm nay là ngày đến hạn",
      "/creator/apply",
    ],
  ] as const)("renders the fixed %s template without sensitive fields", async (purpose, templateData, expectedText, expectedPath) => {
    let delivered: SmtpMail | undefined;
    const sender = createSecurityEmailSender({
      adapter: "smtp",
      appBaseUrl: "https://pawket.example",
      smtp,
      createTransport() {
        return { async sendMail(message) { delivered = message; } };
      },
    });

    await sender.send({
      handoffId: "6c81afe1-1704-4653-a7a8-89630f0c990a",
      purpose,
      destination: "artist@example.com",
      secret: null,
      templateData,
    });

    expect(delivered?.text).toContain(expectedText);
    expect(delivered?.text).toContain(`https://pawket.example${expectedPath}`);
    expect(delivered?.text).not.toMatch(/account number|challenge|portfolio|date of birth/i);
  });

  test("renders reopened application copy distinctly from ordinary changes requested", async () => {
    // Break caught: losing the reopen decision when both outcomes retain the same application database state.
    const delivered: SmtpMail[] = [];
    const sender = createSecurityEmailSender({
      adapter: "smtp",
      appBaseUrl: "https://pawket.example",
      smtp,
      createTransport() {
        return { async sendMail(message) { delivered.push(message); } };
      },
    });

    for (const state of ["changes_requested", "reopened"] as const) {
      await sender.send({
        handoffId: "6c81afe1-1704-4653-a7a8-89630f0c990a",
        purpose: "application_outcome",
        destination: "artist@example.com",
        secret: null,
        templateData: { state },
      });
    }

    expect(delivered[0]?.text).toContain("Pawket cần bạn cập nhật một số nội dung trong hồ sơ creator.");
    expect(delivered[1]?.text).toContain("Pawket đã mở lại hồ sơ creator để bạn tiếp tục cập nhật.");
    expect(delivered[1]?.text).not.toBe(delivered[0]?.text);
    expect(delivered.map((message) => message.to)).toEqual(["artist@example.com", "artist@example.com"]);
    expect(JSON.stringify(delivered)).not.toMatch(/privateNote|applicantExplanation|bank|portfolio|date of birth/i);
  });

  test.each([
    ["session_revoked", "Một phiên đăng nhập Pawket đã được thu hồi"],
    ["sessions_revoked", "Tất cả phiên đăng nhập Pawket đã được thu hồi"],
    ["owner_mfa_break_glass_completed", "Khôi phục MFA khẩn cấp cho owner đã hoàn tất"],
  ] as const)("renders the allowlisted %s security notice", async (event, expectedText) => {
    let delivered: SmtpMail | undefined;
    const sender = createSecurityEmailSender({
      adapter: "smtp",
      appBaseUrl: "https://pawket.example",
      smtp,
      createTransport() {
        return { async sendMail(message) { delivered = message; } };
      },
    });

    await sender.send({
      handoffId: "6c81afe1-1704-4653-a7a8-89630f0c990a",
      purpose: "security_notice",
      destination: "owner@example.com",
      secret: null,
      templateData: { event },
    });

    expect(delivered?.subject).toBe("Thông báo bảo mật Pawket");
    expect(delivered?.text).toContain(expectedText);
  });

  test("fails closed for a security notice event outside the fixed allowlist", async () => {
    const sender = createSecurityEmailSender({
      adapter: "smtp",
      appBaseUrl: "https://pawket.example",
      smtp,
      createTransport() {
        return { async sendMail() {} };
      },
    });

    await expect(
      sender.send({
        handoffId: "6c81afe1-1704-4653-a7a8-89630f0c990a",
        purpose: "security_notice",
        destination: "owner@example.com",
        secret: null,
        templateData: { event: "unbounded-runtime-event" },
      }),
    ).rejects.toThrow("Invalid security email message");
  });

  test("fails before opening a transport when SMTP configuration is incomplete", () => {
    // Catches a deployed worker starting with partial credentials or exposing their values.
    const leakedPassword = "smtp-password-that-must-not-leak";
    let transportCreated = false;
    let thrown: unknown;

    try {
      createSecurityEmailSender({
        adapter: "smtp",
        appBaseUrl: "https://pawket.example",
        smtp: { password: leakedPassword },
        createTransport() {
          transportCreated = true;
          return { async sendMail() {} };
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("Invalid SMTP security email configuration");
    expect((thrown as Error).message).not.toContain(leakedPassword);
    expect(transportCreated).toBe(false);
  });

  test("maps the worker environment into the SMTP transport without exposing it to web", () => {
    // Catches swapping or dropping deployment variables at the worker boundary.
    let transportOptions: SmtpTransportOptions | undefined;

    createSecurityEmailSenderFromEnv({
      env: {
        APP_BASE_URL: "https://pawket.example",
        SECURITY_EMAIL_ADAPTER: "smtp",
        SMTP_HOST: "smtp.transactional.example",
        SMTP_PORT: 587,
        SMTP_TLS_MODE: "starttls",
        SMTP_USERNAME: "pawket-production",
        SMTP_PASSWORD: "smtp-password-that-must-not-leak",
        SMTP_FROM_EMAIL: "security@pawket.example",
        SMTP_FROM_NAME: "Pawket Security",
      },
      createTransport(options) {
        transportOptions = options;
        return { async sendMail() {} };
      },
    });

    expect(transportOptions).toEqual({
      host: "smtp.transactional.example",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: {
        user: "pawket-production",
        pass: "smtp-password-that-must-not-leak",
      },
    });
  });
});

describe("worker scan health", () => {
  test.each([
    ["partial", { claimed: 2, enqueued: 1, failed: 1 }],
    ["all", { claimed: 2, enqueued: 0, failed: 2 }],
  ] as const)(
    "keeps an outbox scan unhealthy when %s dispatch returns enqueue failures",
    async (_kind, dispatchResult) => {
      // Catches resolved per-event dispatch failures being reported as a successful poll.
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"));
      metricsRegistry.resetMetrics();
      const errors: Array<{ data: Record<string, unknown>; message?: string }> = [];
      const healthState = {
        initializedAt: null,
        lastPollSucceededAt: null,
        lastRefundScanSucceededAt: null,
        stopping: false,
      };
      const resource = {
        close: vi.fn(async () => undefined),
        disconnect: vi.fn(async () => undefined),
      };
      const connection = {
        connect: vi.fn(async () => undefined),
        quit: vi.fn(async () => undefined),
        disconnect: vi.fn(),
      };
      const handle = await workerRuntime.startWorker({
        databaseUrl: "postgresql://unused:unused@127.0.0.1:5432/unused",
        valkeyUrl: "redis://127.0.0.1:6379/15",
        concurrency: 1,
        batchSize: 10,
        leaseMs: 30_000,
        signalSource: new EventEmitter(),
        healthState,
        logger: {
          info() {},
          error(data, message) {
            errors.push({ data, message });
          },
        },
        dependencies: {
          createDatabase: () => ({ db: {}, close: resource.close }) as never,
          createProducerConnection: () => connection as never,
          createWorkerConnection: () => connection as never,
          createQueue: () => resource as never,
          createWorker: () => resource as never,
          dispatch: vi.fn(async () => dispatchResult) as never,
          acknowledge: vi.fn() as never,
          scanRefundWindows: vi.fn(async () => ({
            dueSoon: 0,
            dueToday: 0,
            overdue: 0,
            attention: 0,
            outstandingAmountVnd: 0,
          })) as never,
          readBacklogMetrics: vi.fn(async () => ({
            outbox: { pending: 1, oldestAgeSeconds: 1 },
            email: { pending: 0, oldestAgeSeconds: 0, attention: 0 },
            publicMedia: { oldestPendingSeconds: 0 },
            publicContentReports: { oldestOpenSeconds: 0 },
          })) as never,
          runRetention: vi.fn() as never,
          hostname: () => "test-worker",
          randomUUID: () => "42b386d6-c7f1-4d11-a3c9-97ac728285c3",
        },
      });

      await vi.advanceTimersByTimeAsync(0);

      expect(await scanHealth("outbox")).toBe(0);
      expect(healthState.lastPollSucceededAt).toBeNull();
      const lastSuccess = metricsRegistry.getSingleMetric(
        "pawket_worker_last_success_timestamp_seconds",
      );
      expect(
        (await lastSuccess?.get())?.values.some((value) => value.labels.scan === "outbox"),
      ).toBe(false);
      expect(errors).toContainEqual({
        data: {
          category: "outbox_dispatch_incomplete",
          workerId: "test-worker:42b386d6-c7f1-4d11-a3c9-97ac728285c3",
          ...dispatchResult,
        },
        message: "Outbox dispatch completed with enqueue failures",
      });
      expect(JSON.stringify(errors)).not.toContain("exception");
      expect(JSON.stringify(errors)).not.toContain("secret");

      await handle.stop();
    },
  );

  test.each(["dispatch", "backlog"] as const)(
    "runs a due retention scan when the outbox %s phase fails",
    async (failureStage) => {
      // Break caught: nesting retention scheduling under a successful outbox
      // dispatch/backlog path and leaving a stale healthy retention gauge.
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"));
      metricsRegistry.resetMetrics();
      const resource = {
        close: vi.fn(async () => undefined),
        disconnect: vi.fn(async () => undefined),
      };
      const connection = {
        connect: vi.fn(async () => undefined),
        quit: vi.fn(async () => undefined),
        disconnect: vi.fn(),
      };
      const dispatch =
        failureStage === "dispatch"
          ? vi.fn(async () => {
              throw new Error("outbox-dispatch-secret");
            })
          : vi.fn(async () => ({ claimed: 0, enqueued: 0, failed: 0 }));
      const readBacklogMetrics =
        failureStage === "backlog"
          ? vi.fn(async () => {
              throw new Error("outbox-backlog-secret");
            })
          : vi.fn(async () => ({
              outbox: { pending: 0, oldestAgeSeconds: 0 },
              email: { pending: 0, oldestAgeSeconds: 0, attention: 0 },
              publicMedia: { oldestPendingSeconds: 0 },
              publicContentReports: { oldestOpenSeconds: 0 },
            }));
      const runRetention = vi.fn(async () => []);
      const handle = await workerRuntime.startWorker({
        databaseUrl: "postgresql://unused:unused@127.0.0.1:5432/unused",
        valkeyUrl: "redis://127.0.0.1:6379/15",
        concurrency: 1,
        batchSize: 10,
        leaseMs: 30_000,
        signalSource: new EventEmitter(),
        logger: { info() {}, error() {} },
        retention: {
          mode: "report_only",
          policyVersion: "task-9-test",
          enforcementPaused: true,
          batchSize: 10,
          scanIntervalMs: 1_000,
        },
        dependencies: {
          createDatabase: () => ({ db: {}, close: resource.close }) as never,
          createProducerConnection: () => connection as never,
          createWorkerConnection: () => connection as never,
          createQueue: () => resource as never,
          createWorker: () => resource as never,
          dispatch: dispatch as never,
          acknowledge: vi.fn() as never,
          scanRefundWindows: vi.fn(async () => ({
            dueSoon: 0,
            dueToday: 0,
            overdue: 0,
            attention: 0,
            outstandingAmountVnd: 0,
          })) as never,
          readBacklogMetrics: readBacklogMetrics as never,
          runRetention: runRetention as never,
          hostname: () => "test-worker",
          randomUUID: () => "42b386d6-c7f1-4d11-a3c9-97ac728285c3",
        },
      });

      await vi.advanceTimersByTimeAsync(0);

      expect(runRetention).toHaveBeenCalledTimes(1);
      expect(await scanHealth("outbox")).toBe(0);
      expect(await scanHealth("retention")).toBe(1);
      const lastSuccess = metricsRegistry.getSingleMetric(
        "pawket_worker_last_success_timestamp_seconds",
      );
      expect(
        (await lastSuccess?.get())?.values.some((value) => value.labels.scan === "retention"),
      ).toBe(true);

      await handle.stop();
    },
  );

  test("marks a due retention scan unhealthy while its promise is still pending", async () => {
    // Break caught: a previously successful scan retaining health=1 while the
    // next due retention execution hangs instead of rejecting.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"));
    metricsRegistry.resetMetrics();
    let releasePendingScan!: () => void;
    const pendingScan = new Promise<void>((resolve) => {
      releasePendingScan = resolve;
    });
    const runRetention = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockImplementationOnce(async () => {
        await pendingScan;
        return [];
      });
    const resource = {
      close: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
    };
    const connection = {
      connect: vi.fn(async () => undefined),
      quit: vi.fn(async () => undefined),
      disconnect: vi.fn(),
    };
    const handle = await workerRuntime.startWorker({
      databaseUrl: "postgresql://unused:unused@127.0.0.1:5432/unused",
      valkeyUrl: "redis://127.0.0.1:6379/15",
      concurrency: 1,
      batchSize: 10,
      leaseMs: 30_000,
      signalSource: new EventEmitter(),
      logger: { info() {}, error() {} },
      retention: {
        mode: "report_only",
        policyVersion: "task-9-test",
        enforcementPaused: true,
        batchSize: 10,
        scanIntervalMs: 1_000,
      },
      dependencies: {
        createDatabase: () => ({ db: {}, close: resource.close }) as never,
        createProducerConnection: () => connection as never,
        createWorkerConnection: () => connection as never,
        createQueue: () => resource as never,
        createWorker: () => resource as never,
        dispatch: vi.fn(async () => ({ claimed: 0, enqueued: 0, failed: 0 })) as never,
        acknowledge: vi.fn() as never,
        scanRefundWindows: vi.fn(async () => ({
          dueSoon: 0,
          dueToday: 0,
          overdue: 0,
          attention: 0,
          outstandingAmountVnd: 0,
        })) as never,
        readBacklogMetrics: vi.fn(async () => ({
          outbox: { pending: 0, oldestAgeSeconds: 0 },
          email: { pending: 0, oldestAgeSeconds: 0, attention: 0 },
          publicMedia: { oldestPendingSeconds: 0 },
          publicContentReports: { oldestOpenSeconds: 0 },
        })) as never,
        runRetention: runRetention as never,
        hostname: () => "test-worker",
        randomUUID: () => "42b386d6-c7f1-4d11-a3c9-97ac728285c3",
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(await scanHealth("retention")).toBe(1);

    vi.advanceTimersByTime(1_000);
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    expect(runRetention).toHaveBeenCalledTimes(2);
    expect(await scanHealth("retention")).toBe(0);

    releasePendingScan();
    await handle.stop();
  });

  test("starts unhealthy, becomes healthy after success, and returns unhealthy on failure", async () => {
    // Catches startup being reported as success and scan failures leaving stale healthy state.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"));
    metricsRegistry.resetMetrics();
    let releaseFirstRefundScan!: () => void;
    const firstRefundScan = new Promise<void>((resolve) => {
      releaseFirstRefundScan = resolve;
    });
    const scanRefundWindows = vi
      .fn()
      .mockImplementationOnce(async () => {
        await firstRefundScan;
        return {
          dueSoon: 0,
          dueToday: 0,
          overdue: 0,
          attention: 0,
          outstandingAmountVnd: 0,
        };
      })
      .mockRejectedValueOnce(new Error("bank-scan-secret"))
      .mockResolvedValue({
        dueSoon: 0,
        dueToday: 0,
        overdue: 0,
        attention: 0,
        outstandingAmountVnd: 0,
      });
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce({ claimed: 0, enqueued: 0, failed: 0 })
      .mockRejectedValueOnce(new Error("outbox-scan-secret"))
      .mockResolvedValue({ claimed: 0, enqueued: 0, failed: 0 });
    const runRetention = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          dataset: "sessions",
          candidateCount: 0,
          protectedCount: 0,
          processedCount: 0,
          outcome: "failed",
        },
      ]);
    const resource = {
      close: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
    };
    const connection = {
      connect: vi.fn(async () => undefined),
      quit: vi.fn(async () => undefined),
      disconnect: vi.fn(),
    };
    const handle = await workerRuntime.startWorker({
      databaseUrl: "postgresql://unused:unused@127.0.0.1:5432/unused",
      valkeyUrl: "redis://127.0.0.1:6379/15",
      concurrency: 1,
      batchSize: 10,
      leaseMs: 30_000,
      signalSource: new EventEmitter(),
      logger: { info() {}, error() {} },
      retention: {
        mode: "report_only",
        policyVersion: "task-9-test",
        enforcementPaused: true,
        batchSize: 10,
        scanIntervalMs: 1_000,
      },
      dependencies: {
        createDatabase: () => ({ db: {}, close: resource.close }) as never,
        createProducerConnection: () => connection as never,
        createWorkerConnection: () => connection as never,
        createQueue: () => resource as never,
        createWorker: () => resource as never,
        dispatch: dispatch as never,
        acknowledge: vi.fn() as never,
        scanRefundWindows: scanRefundWindows as never,
        readBacklogMetrics: vi.fn(async () => ({
          outbox: { pending: 0, oldestAgeSeconds: 0 },
          email: { pending: 0, oldestAgeSeconds: 0, attention: 0 },
          publicMedia: { oldestPendingSeconds: 0 },
          publicContentReports: { oldestOpenSeconds: 0 },
        })) as never,
        runRetention: runRetention as never,
        hostname: () => "test-worker",
        randomUUID: () => "42b386d6-c7f1-4d11-a3c9-97ac728285c3",
      },
    });

    expect(await scanHealth("outbox")).toBe(0);
    expect(await scanHealth("refund")).toBe(0);
    expect(await scanHealth("retention")).toBe(0);

    releaseFirstRefundScan();
    await vi.advanceTimersByTimeAsync(0);
    expect(await scanHealth("outbox")).toBe(1);
    expect(await scanHealth("refund")).toBe(1);
    expect(await scanHealth("retention")).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(await scanHealth("outbox")).toBe(0);

    vi.setSystemTime(new Date("2026-08-26T00:01:00.000Z"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await scanHealth("refund")).toBe(0);
    expect(await scanHealth("retention")).toBe(0);

    await handle.stop();
  });
});
