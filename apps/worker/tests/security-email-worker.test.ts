import { describe, expect, test, vi } from "vitest";

import {
  createSecurityEmailSender,
  createSecurityEmailSenderFromEnv,
  type SmtpMail,
  type SmtpTransportOptions,
} from "../src/security-email.js";
import * as workerRuntime from "../src/worker-runtime.js";

type ProcessorFactory = {
  createWorkerJobProcessor(input: {
    logger: { info(data: Record<string, unknown>, message?: string): void; error(data: Record<string, unknown>, message?: string): void };
    database: never;
    acknowledge: (db: never, input: { eventId: string }) => Promise<boolean>;
    securityEmail?: {
      keyring: never;
      sender: never;
      deliver: (db: never, input: Record<string, unknown>) => Promise<"delivered" | "already_delivered">;
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

describe("security email worker contract", () => {
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

  test("requires STARTTLS and sends a purpose-bound password reset message", async () => {
    // Catches plaintext SMTP or sending a challenge without its Pawket URL.
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
      purpose: "password_reset",
      destination: "artist@example.com",
      secret: "one-time-secret",
      templateData: { returnPath: "/reset-password" },
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
      subject: "Reset your Pawket password",
      text:
        "Reset your Pawket password\n\n" +
        "Open this Pawket link to continue:\n" +
        "https://pawket.example/reset-password?token=one-time-secret\n\n" +
        "This link expires in 30 minutes. If you did not request this, you can ignore this email.",
    });
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
