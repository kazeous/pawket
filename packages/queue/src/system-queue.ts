import { Queue, type JobsOptions } from "bullmq";
import type { Redis } from "ioredis";

import {
  claimOutboxBatch,
  markOutboxFailed,
  type OutboxEvent,
  type PawketDatabase,
} from "@pawket/database";

export const SYSTEM_QUEUE = "pawket.system";
export const OUTBOX_JOB = "system.outbox-event";

export type SystemOutboxJob = {
  outboxEventId: string;
  eventType: string;
  eventVersion: number;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  occurredAt: string;
};

class UnsafeOutboxPayloadError extends Error {}

const sensitiveKeyParts = [
  "password",
  "secret",
  "token",
  "credential",
  "authorization",
  "cookie",
  "databaseurl",
  "valkeyurl",
];
const connectionUrlPattern =
  /(?:postgres(?:ql)?|redis|rediss|mysql|mongodb(?:\+srv)?|amqp|amqps):\/\/[^\s]+/i;
const credentialUrlPattern = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/]+@/i;

function assertSafeJobValue(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value === "string") {
    if (connectionUrlPattern.test(value) || credentialUrlPattern.test(value)) {
      throw new UnsafeOutboxPayloadError("Unsafe outbox job data");
    }
    return;
  }

  if (typeof value !== "object" || value === null) {
    return;
  }
  if (seen.has(value)) {
    throw new UnsafeOutboxPayloadError("Unsafe outbox job data");
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      assertSafeJobValue(item, seen);
    }
    return;
  }

  for (const [key, childValue] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (sensitiveKeyParts.some((part) => normalizedKey.includes(part))) {
      throw new UnsafeOutboxPayloadError("Unsafe outbox job data");
    }
    assertSafeJobValue(childValue, seen);
  }
}

class SafeSystemQueue extends Queue<SystemOutboxJob> {
  override add(name: string, data: SystemOutboxJob, options?: JobsOptions) {
    assertSafeJobValue(data);
    return super.add(name, data, options);
  }
}

export function createSystemQueue(connection: Redis): Queue<SystemOutboxJob> {
  return new SafeSystemQueue(SYSTEM_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: 8,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: { age: 86_400, count: 10_000 },
      removeOnFail: false,
    },
  });
}

export type SystemQueuePublisher = {
  add(
    name: string,
    data: SystemOutboxJob,
    options: JobsOptions,
  ): Promise<{ id?: string }>;
};

export function enqueueSystemOutboxJob<TQueue extends SystemQueuePublisher>(
  queue: TQueue,
  payload: SystemOutboxJob,
): ReturnType<TQueue["add"]> {
  assertSafeJobValue(payload);
  return queue.add(OUTBOX_JOB, payload, {
    jobId: payload.outboxEventId,
    attempts: 8,
    backoff: { type: "exponential", delay: 1_000 },
    removeOnComplete: { age: 86_400, count: 10_000 },
    removeOnFail: false,
  }) as ReturnType<TQueue["add"]>;
}

type MarkFailed = typeof markOutboxFailed;

export type DispatchOutboxDependencies = {
  db: PawketDatabase;
  queue: SystemQueuePublisher;
  markFailed?: MarkFailed;
};

export type DispatchOutboxOptions = {
  workerId: string;
  batchSize: number;
  leaseMs: number;
  retryDelayMs?: number;
  now?: () => Date;
};

function toJobPayload(event: OutboxEvent): SystemOutboxJob {
  return {
    outboxEventId: event.id,
    eventType: event.eventType,
    eventVersion: event.eventVersion,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    payload: event.payload,
    occurredAt: event.occurredAt.toISOString(),
  };
}

function failureCategory(error: unknown): string {
  return error instanceof UnsafeOutboxPayloadError
    ? "outbox_payload_rejected"
    : "outbox_delivery_failed";
}

export async function dispatchOutboxBatch(
  dependencies: DispatchOutboxDependencies,
  options: DispatchOutboxOptions,
): Promise<{ claimed: number; enqueued: number; failed: number }> {
  const now = options.now?.() ?? new Date();
  const events = await claimOutboxBatch(dependencies.db, {
    workerId: options.workerId,
    limit: options.batchSize,
    leaseMs: options.leaseMs,
    now,
  });
  let enqueued = 0;
  let failed = 0;

  for (const event of events) {
    try {
      await enqueueSystemOutboxJob(dependencies.queue, toJobPayload(event));
      enqueued += 1;
    } catch (error) {
      failed += 1;
      await (dependencies.markFailed ?? markOutboxFailed)(dependencies.db, {
        eventId: event.id,
        workerId: options.workerId,
        error: failureCategory(error),
        nextAttemptAt: new Date(now.getTime() + (options.retryDelayMs ?? 1_000)),
      });
    }
  }

  return { claimed: events.length, enqueued, failed };
}
