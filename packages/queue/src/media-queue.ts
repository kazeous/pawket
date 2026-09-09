import { types as nodeTypes } from "node:util";

import { Queue, type JobsOptions } from "bullmq";
import type { Redis } from "ioredis";

import {
  PRODUCER_OPERATION_TIMEOUT_MS,
  withProducerOperationDeadline,
} from "./connection.js";

export const MEDIA_QUEUE = "pawket.media";
export const MEDIA_PROCESS_JOB = "media.process-public-asset";

export type MediaAssetJob = Readonly<{ assetId: string }>;
export type PublicMediaCompletedPayload = Readonly<{
  assetId: string;
  ownerUserId: string;
  purpose: "avatar" | "cover" | "showcase";
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const OWNER_ID = /^[A-Za-z0-9._-]{8,200}$/u;

function exactOwnRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value)) return null;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return null;
  }
}

function mediaJobData(value: unknown): MediaAssetJob {
  const record = exactOwnRecord(value, ["assetId"]);
  if (!record || typeof record.assetId !== "string" || !UUID.test(record.assetId)) {
    throw new Error("Invalid public media asset job");
  }
  return { assetId: record.assetId };
}

export function parsePublicMediaCompletedPayload(value: unknown): PublicMediaCompletedPayload {
  const record = exactOwnRecord(value, ["assetId", "ownerUserId", "purpose"]);
  if (
    !record ||
    typeof record.assetId !== "string" ||
    !UUID.test(record.assetId) ||
    typeof record.ownerUserId !== "string" ||
    !OWNER_ID.test(record.ownerUserId) ||
    (record.purpose !== "avatar" && record.purpose !== "cover" && record.purpose !== "showcase")
  ) throw new Error("Invalid public media completion payload");
  return {
    assetId: record.assetId,
    ownerUserId: record.ownerUserId,
    purpose: record.purpose,
  };
}

function jobOptions(data: MediaAssetJob, options?: JobsOptions): JobsOptions {
  if (options?.jobId !== undefined && options.jobId !== data.assetId) {
    throw new Error("Public media job ID must match asset ID");
  }
  return { ...options, jobId: data.assetId };
}

export class SafeMediaQueue extends Queue<MediaAssetJob> {
  override add(name: string, data: MediaAssetJob, options?: JobsOptions) {
    if (name !== MEDIA_PROCESS_JOB) throw new Error("Invalid public media job name");
    const safeData = mediaJobData(data);
    return super.add(name, safeData, jobOptions(safeData, options));
  }

  override addBulk(jobs: Parameters<Queue<MediaAssetJob>["addBulk"]>[0]) {
    return super.addBulk(jobs.map((job) => {
      if (job.name !== MEDIA_PROCESS_JOB) throw new Error("Invalid public media job name");
      const data = mediaJobData(job.data);
      return { ...job, data, opts: jobOptions(data, job.opts) };
    }));
  }
}

export function createMediaQueue(connection: Redis): SafeMediaQueue {
  return new SafeMediaQueue(MEDIA_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: 8,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: { age: 86_400, count: 10_000 },
      removeOnFail: false,
    },
  });
}

export type MediaQueuePublisher = Readonly<{
  add(
    name: string,
    data: MediaAssetJob,
    options: JobsOptions,
  ): Promise<{
    id?: string;
    data?: MediaAssetJob;
    getState?(): Promise<string>;
    retry?(state?: "failed"): Promise<void>;
  }>;
}>;

export async function enqueueMediaAsset<TQueue extends MediaQueuePublisher>(
  queue: TQueue,
  assetId: string,
  timeoutMs = PRODUCER_OPERATION_TIMEOUT_MS,
): Promise<Awaited<ReturnType<TQueue["add"]>>> {
  const data = mediaJobData({ assetId });
  const job = await withProducerOperationDeadline(
    () => queue.add(MEDIA_PROCESS_JOB, data, {
      jobId: data.assetId,
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
