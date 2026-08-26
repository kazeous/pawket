import { EventEmitter } from "node:events";

import { afterEach, describe, expect, test, vi } from "vitest";

import { metricsRegistry } from "@pawket/observability";

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
      subject: "Đặt lại mật khẩu Pawket",
      text:
        "Đặt lại mật khẩu Pawket\n\n" +
        "Mở liên kết Pawket này để tiếp tục:\n" +
        "https://pawket.example/reset-password?token=one-time-secret\n\n" +
        "Liên kết hết hạn sau 30 phút. Nếu bạn không yêu cầu thao tác này, hãy bỏ qua email.",
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

  test("routes authenticated email changes to the purpose-specific confirmation page", async () => {
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
      purpose: "email_change",
      destination: "artist-new@example.com",
      secret: "email-change-secret",
      templateData: { returnPath: "/settings/security/confirm-email" },
    });

    expect(delivered?.text).toContain(
      "https://pawket.example/settings/security/confirm-email?token=email-change-secret",
    );
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
