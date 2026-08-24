import { describe, expect, test, vi } from "vitest";

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
