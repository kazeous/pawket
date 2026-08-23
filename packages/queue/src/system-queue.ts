import { Queue, type JobsOptions } from "bullmq";
import type { Redis } from "ioredis";

import {
  claimOutboxBatch,
  markOutboxFailed,
  markOutboxPublished,
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

export function createSystemQueue(connection: Redis): Queue<SystemOutboxJob> {
  return new Queue<SystemOutboxJob>(SYSTEM_QUEUE, {
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
  return queue.add(OUTBOX_JOB, payload, {
    jobId: payload.outboxEventId,
    attempts: 8,
    backoff: { type: "exponential", delay: 1_000 },
    removeOnComplete: { age: 86_400, count: 10_000 },
    removeOnFail: false,
  }) as ReturnType<TQueue["add"]>;
}

type MarkPublished = typeof markOutboxPublished;
type MarkFailed = typeof markOutboxFailed;

export type DispatchOutboxDependencies = {
  db: PawketDatabase;
  queue: SystemQueuePublisher;
  markPublished?: MarkPublished;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown outbox dispatch failure";
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
      const published = await (dependencies.markPublished ?? markOutboxPublished)(
        dependencies.db,
        { eventId: event.id, workerId: options.workerId, publishedAt: now },
      );
      if (!published) {
        throw new Error("Outbox acknowledgement rejected because the lease is no longer owned");
      }
    } catch (error) {
      failed += 1;
      await (dependencies.markFailed ?? markOutboxFailed)(dependencies.db, {
        eventId: event.id,
        workerId: options.workerId,
        error: errorMessage(error),
        nextAttemptAt: new Date(now.getTime() + (options.retryDelayMs ?? 1_000)),
      });
    }
  }

  return { claimed: events.length, enqueued, failed };
}
