import { types as nodeTypes } from "node:util";

import { Queue, type JobsOptions } from "bullmq";
import type { Redis } from "ioredis";

import { PRODUCER_OPERATION_TIMEOUT_MS, withProducerOperationDeadline } from "./connection.js";

export const COMMISSION_FILE_QUEUE = "pawket.commission-files";
export const COMMISSION_FILE_SCAN_JOB = "commission-file.scan";
export type CommissionFileScanJob = Readonly<{ fileId: string; attempt: number }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CORRELATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value)) return null;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || own.some((key) => typeof key !== "string" || !keys.includes(key))) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value); const output: Record<string, unknown> = {};
    for (const key of keys) { const descriptor = descriptors[key]; if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null; output[key] = descriptor.value; }
    return output;
  } catch { return null; }
}

export function parseCommissionFileJob(value: unknown): CommissionFileScanJob {
  const record = exactRecord(value, ["fileId", "attempt"]);
  if (!record || typeof record.fileId !== "string" || !UUID.test(record.fileId) || !Number.isInteger(record.attempt) || (record.attempt as number) < 0 || (record.attempt as number) > 1000) {
    throw new Error("Invalid commission file job");
  }
  return { fileId: record.fileId, attempt: record.attempt as number };
}
export function commissionFileScanJobId(fileId: string, attempt: number): string {
  const job = parseCommissionFileJob({ fileId, attempt });
  return `${job.fileId}-a${job.attempt}`;
}
export function parseCommissionFileUploadedPayload(value: unknown): Readonly<{ fileId: string; correlationId: string }> {
  const record = exactRecord(value, ["fileId", "correlationId"]);
  if (!record || typeof record.fileId !== "string" || !UUID.test(record.fileId) || typeof record.correlationId !== "string" || !CORRELATION.test(record.correlationId)) {
    throw new Error("Invalid commission file upload payload");
  }
  return { fileId: record.fileId, correlationId: record.correlationId };
}

const JOB_OPTIONS: JobsOptions = { attempts: 1, removeOnComplete: { age: 86_400, count: 10_000 }, removeOnFail: { age: 7 * 86_400, count: 10_000 } };

export class SafeCommissionFileQueue extends Queue<CommissionFileScanJob> {
  override add(name: string, data: CommissionFileScanJob, options?: JobsOptions) {
    if (name !== COMMISSION_FILE_SCAN_JOB) throw new Error("Invalid commission file job name");
    const job = parseCommissionFileJob(data); const jobId = commissionFileScanJobId(job.fileId, job.attempt);
    if (options?.jobId !== undefined && options.jobId !== jobId) throw new Error("Commission file job ID must match its attempt");
    return super.add(name, job, { ...JOB_OPTIONS, ...options, jobId });
  }
}
export function createCommissionFileQueue(connection: Redis): SafeCommissionFileQueue {
  return new SafeCommissionFileQueue(COMMISSION_FILE_QUEUE, { connection, defaultJobOptions: JOB_OPTIONS });
}
export type CommissionFileQueuePublisher = Readonly<{ add(name: string, data: CommissionFileScanJob, options: JobsOptions): Promise<{ id?: string }> }>;

/** Retries are scheduled by the database (`next_scan_at`), not by BullMQ backoff, so each attempt gets its own job ID. */
export async function enqueueCommissionFileScan(queue: CommissionFileQueuePublisher, fileId: string, attempt: number, timeoutMs = PRODUCER_OPERATION_TIMEOUT_MS) {
  const data = parseCommissionFileJob({ fileId, attempt });
  return withProducerOperationDeadline(() => queue.add(COMMISSION_FILE_SCAN_JOB, data, { ...JOB_OPTIONS, jobId: commissionFileScanJobId(data.fileId, data.attempt) }), timeoutMs);
}
