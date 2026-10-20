import { randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { metricsRegistry } from "@pawket/observability";
import { OUTBOX_JOB } from "@pawket/queue";
import { createWorkerJobProcessor } from "../src/worker-runtime.js";

function job(eventType: string) {
  const id = randomUUID();
  return { id, name: OUTBOX_JOB, data: { outboxEventId: id, eventType, eventVersion: 1, aggregateType: "trust_penalty", aggregateId: randomUUID(), payload: {}, occurredAt: "2026-10-12T03:00:00.000Z" } };
}
function processor(notifications?: { materialize: ReturnType<typeof vi.fn> }, materializeEmail?: ReturnType<typeof vi.fn>) {
  const acknowledge = vi.fn(async () => true); const logger = { info: vi.fn(), error: vi.fn() };
  const run = createWorkerJobProcessor({ logger, database: {} as never, acknowledge: acknowledge as never,
    ...(materializeEmail ? { securityEmail: { keyring: {} as never, sender: {} as never, materialize: materializeEmail as never } } : {}),
    ...(notifications ? { notifications: notifications as never } : {}) });
  return { run: (data: ReturnType<typeof job>) => run(data as never), acknowledge, logger };
}
const metric = async (outcome: string) => {
  const line = (await metricsRegistry.metrics()).split("\n").find((entry) => entry.startsWith(`pawket_notification_operations_total{operation="materialize",outcome="${outcome}"}`));
  return line ? Number(line.split(" ").at(-1)) : 0;
};

describe("notification hook in the outbox processor", () => {
  test("a source event is materialized after its branch and before acknowledgement", async () => {
    const materialize = vi.fn(async () => ({ created: 1, emailed: 1 })); const p = processor({ materialize });
    const created = await metric("created"); const data = job("trust.penalty_applied.v1");
    await p.run(data);
    expect(materialize).toHaveBeenCalledExactlyOnceWith(data.data);
    expect(p.acknowledge).toHaveBeenCalledOnce();
    expect(materialize.mock.invocationCallOrder[0]).toBeLessThan(p.acknowledge.mock.invocationCallOrder[0]!);
    expect(await metric("created")).toBe(created + 1);
  });

  test("a domain email event is materialized after its email handoff", async () => {
    const materialize = vi.fn(async () => ({ created: 1, emailed: 0 })); const email = vi.fn(async () => "created");
    const p = processor({ materialize }, email); const data = job("creator.capability_outcome_email.v1");
    await p.run(data);
    expect(email.mock.invocationCallOrder[0]).toBeLessThan(materialize.mock.invocationCallOrder[0]!);
    expect(materialize.mock.invocationCallOrder[0]).toBeLessThan(p.acknowledge.mock.invocationCallOrder[0]!);
  });

  test("a failed branch never materializes", async () => {
    const materialize = vi.fn(async () => ({ created: 1, emailed: 0 })); const email = vi.fn(async () => { throw new Error("synthetic"); });
    const p = processor({ materialize }, email);
    await expect(p.run(job("creator.capability_outcome_email.v1"))).rejects.toThrow();
    expect(materialize).not.toHaveBeenCalled(); expect(p.acknowledge).not.toHaveBeenCalled();
  });

  test("events outside the source set are acknowledged without materializing", async () => {
    const materialize = vi.fn(async () => ({ created: 0, emailed: 0 })); const p = processor({ materialize });
    await p.run(job("identity.user_registered.v1")); await p.run(job("creator.page_published.v1"));
    expect(materialize).not.toHaveBeenCalled(); expect(p.acknowledge).toHaveBeenCalledTimes(2);
  });

  test("a materialization failure is retried and the event stays unacknowledged", async () => {
    const materialize = vi.fn(async () => { throw new Error("private-content synthetic failure"); }); const p = processor({ materialize });
    const failed = await metric("failed");
    await expect(p.run(job("tip.notification_available.v1"))).rejects.toThrow("Notification materialization failed");
    expect(p.acknowledge).not.toHaveBeenCalled();
    expect(await metric("failed")).toBe(failed + 1);
    expect(JSON.stringify(p.logger.error.mock.calls)).not.toContain("private-content");
  });

  test("an unwired processor acknowledges source events exactly as before", async () => {
    const p = processor();
    await p.run(job("trust.penalty_applied.v1"));
    expect(p.acknowledge).toHaveBeenCalledOnce();
  });

  test("an event with no recipients records a skip", async () => {
    const materialize = vi.fn(async () => ({ created: 0, emailed: 0 })); const p = processor({ materialize });
    const skipped = await metric("skipped");
    await p.run(job("trust.report_received.v1"));
    expect(await metric("skipped")).toBe(skipped + 1); expect(p.acknowledge).toHaveBeenCalledOnce();
  });
});
