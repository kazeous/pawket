import { randomUUID } from "node:crypto";

import { describe, expect, test, vi } from "vitest";

import {
  COMMISSION_FILE_QUEUE,
  COMMISSION_FILE_SCAN_JOB,
  commissionFileScanJobId,
  enqueueCommissionFileScan,
  parseCommissionFileJob,
  parseCommissionFileUploadedPayload,
} from "../src/commission-file-queue.js";

describe("commission file queue", () => {
  test("uses one job identity per file attempt and carries no private fields", async () => {
    const fileId = randomUUID();
    const add = vi.fn(async (_name: string, data: { fileId: string; attempt: number }, options: { jobId?: string }) => ({ id: options.jobId, data }));
    const job = await enqueueCommissionFileScan({ add }, fileId, 0);
    expect(COMMISSION_FILE_QUEUE).toBe("pawket.commission-files");
    expect(add).toHaveBeenCalledWith(COMMISSION_FILE_SCAN_JOB, { fileId, attempt: 0 }, expect.objectContaining({ jobId: `${fileId}-a0` }));
    expect(job.id).toBe(commissionFileScanJobId(fileId, 0));
    expect(JSON.stringify(add.mock.calls[0]![1])).not.toMatch(/objectKey|filename|url|orderId/iu);
  });
  test("rejects malformed jobs before touching Valkey", async () => {
    const add = vi.fn();
    await expect(enqueueCommissionFileScan({ add }, "../x", 0)).rejects.toThrow("Invalid commission file job");
    await expect(enqueueCommissionFileScan({ add }, randomUUID(), -1)).rejects.toThrow("Invalid commission file job");
    expect(add).not.toHaveBeenCalled();
    expect(() => parseCommissionFileJob({ fileId: randomUUID(), attempt: 0, extra: true })).toThrow("Invalid commission file job");
  });
  test("parses the exact upload-completed payload", () => {
    const fileId = randomUUID();
    expect(parseCommissionFileUploadedPayload({ fileId, correlationId: "req-1" })).toEqual({ fileId, correlationId: "req-1" });
    expect(() => parseCommissionFileUploadedPayload({ fileId, correlationId: "req-1", filename: "a.png" })).toThrow();
    expect(() => parseCommissionFileUploadedPayload({ fileId: "x", correlationId: "req-1" })).toThrow();
  });
});
