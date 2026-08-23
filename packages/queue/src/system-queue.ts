import { Queue, type JobsOptions } from "bullmq";
import type { Redis } from "ioredis";

import {
  PRODUCER_OPERATION_TIMEOUT_MS,
  withProducerOperationDeadline,
} from "./connection.js";

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
  "apikey",
  "accesskey",
  "password",
  "secret",
  "token",
  "credential",
  "authorization",
  "cookie",
  "databaseurl",
  "valkeyurl",
];
const sensitiveExactKeys = new Set(["auth", "oauth"]);
const connectionUrlPattern =
  /(?:postgres(?:ql)?|redis|rediss|mysql|mongodb(?:\+srv)?|amqp|amqps):\/\/[^\s]+/i;

function normalizedKeyIsSensitive(key: string): boolean {
  const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    sensitiveExactKeys.has(normalizedKey) ||
    sensitiveKeyParts.some((part) => normalizedKey.includes(part))
  );
}

function stringContainsCredentials(value: string): boolean {
  if (connectionUrlPattern.test(value)) {
    return true;
  }

  try {
    const url = new URL(value);
    if (url.username || url.password) {
      return true;
    }
    for (const key of url.searchParams.keys()) {
      if (normalizedKeyIsSensitive(key)) {
        return true;
      }
    }
  } catch {
    // Plain application strings are allowed.
  }

  return false;
}

function assertSafeJobValue(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value === "string") {
    if (stringContainsCredentials(value)) {
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
    if (normalizedKeyIsSensitive(key)) {
      throw new UnsafeOutboxPayloadError("Unsafe outbox job data");
    }
    assertSafeJobValue(childValue, seen);
  }
}

function canonicalizeJobData<T>(data: T): T {
  try {
    const serialized = JSON.stringify(data);
    if (serialized === undefined) {
      throw new UnsafeOutboxPayloadError("Unsafe outbox job data");
    }
    const canonical = JSON.parse(serialized) as T;
    assertSafeJobValue(canonical);
    return canonical;
  } catch {
    throw new UnsafeOutboxPayloadError("Unsafe outbox job data");
  }
}

class SafeSystemQueue extends Queue<SystemOutboxJob> {
  override add(name: string, data: SystemOutboxJob, options?: JobsOptions) {
    return super.add(name, canonicalizeJobData(data), options);
  }

  override addBulk(
    jobs: Parameters<Queue<SystemOutboxJob>["addBulk"]>[0],
  ) {
    const canonicalJobs = jobs.map((job) => ({
      ...job,
      data: canonicalizeJobData(job.data),
    }));
    return super.addBulk(canonicalJobs);
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
  ): Promise<{
    id?: string;
    getState?(): Promise<string>;
    retry?(state?: "failed"): Promise<void>;
  }>;
};

export async function enqueueSystemOutboxJob<TQueue extends SystemQueuePublisher>(
  queue: TQueue,
  payload: SystemOutboxJob,
  timeoutMs = PRODUCER_OPERATION_TIMEOUT_MS,
): Promise<Awaited<ReturnType<TQueue["add"]>>> {
  const canonicalPayload = canonicalizeJobData(payload);
  const job = await withProducerOperationDeadline(
    () =>
      queue.add(OUTBOX_JOB, canonicalPayload, {
        jobId: payload.outboxEventId,
        attempts: 8,
        backoff: { type: "exponential", delay: 1_000 },
        removeOnComplete: { age: 86_400, count: 10_000 },
        removeOnFail: false,
      }) as ReturnType<TQueue["add"]>,
    timeoutMs,
  );

  if (job.getState && job.retry) {
    const state = await withProducerOperationDeadline(
      () => job.getState?.() as Promise<string>,
      timeoutMs,
    );
    if (state === "failed") {
      await withProducerOperationDeadline(
        () => job.retry?.("failed") as Promise<void>,
        timeoutMs,
      );
    }
  }

  return job as Awaited<ReturnType<TQueue["add"]>>;
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
  enqueueTimeoutMs?: number;
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
      await enqueueSystemOutboxJob(
        dependencies.queue,
        toJobPayload(event),
        options.enqueueTimeoutMs,
      );
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
