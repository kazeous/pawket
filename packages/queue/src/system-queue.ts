import { Queue, type JobsOptions } from "bullmq";
import type { Redis } from "ioredis";
import { canonicalizeSafeStructuredData } from "@pawket/security/structured-data";

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

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function canonicalizeJobData(data: SystemOutboxJob): SystemOutboxJob {
  try {
    const canonical = canonicalizeSafeStructuredData(data, "job");
    if (
      typeof canonical.outboxEventId !== "string" ||
      !uuidPattern.test(canonical.outboxEventId)
    ) {
      throw new UnsafeOutboxPayloadError("Unsafe outbox job data");
    }
    return canonical;
  } catch {
    throw new UnsafeOutboxPayloadError("Unsafe outbox job data");
  }
}

function canonicalJobOptions(
  data: SystemOutboxJob,
  options: JobsOptions | undefined,
): JobsOptions {
  if (options?.jobId !== undefined && options.jobId !== data.outboxEventId) {
    throw new Error("canonical outbox job ID must match outboxEventId");
  }

  return { ...options, jobId: data.outboxEventId };
}

export class SafeSystemQueue extends Queue<SystemOutboxJob> {
  override add(name: string, data: SystemOutboxJob, options?: JobsOptions) {
    const canonical = canonicalizeJobData(data);
    return super.add(name, canonical, canonicalJobOptions(canonical, options));
  }

  override addBulk(
    jobs: Parameters<Queue<SystemOutboxJob>["addBulk"]>[0],
  ) {
    const canonicalJobs = jobs.map((job) => {
      const data = canonicalizeJobData(job.data);
      return {
        ...job,
        data,
        opts: canonicalJobOptions(data, job.opts),
      };
    });
    return super.addBulk(canonicalJobs);
  }
}

export function createSystemQueue(connection: Redis): SafeSystemQueue {
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
        jobId: canonicalPayload.outboxEventId,
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
