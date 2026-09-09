import { randomUUID } from "node:crypto";

import { describe, expect, test, vi } from "vitest";

import {
  MEDIA_PROCESS_JOB,
  MEDIA_QUEUE,
  enqueueMediaAsset,
  parsePublicMediaCompletedPayload,
} from "../src/media-queue.js";

describe("public media queue", () => {
  test("uses the asset ID as the stable media job identity", async () => {
    const assetId = randomUUID();
    const jobs = new Map<string, { id: string; data: { assetId: string } }>();
    const add = vi.fn(async (name: string, data: { assetId: string }, options: { jobId: string }) => {
      expect(name).toBe(MEDIA_PROCESS_JOB);
      const existing = jobs.get(options.jobId);
      if (existing) return existing;
      const job = { id: options.jobId, data };
      jobs.set(options.jobId, job);
      return job;
    });

    const first = await enqueueMediaAsset({ add }, assetId);
    const replay = await enqueueMediaAsset({ add }, assetId);

    expect(MEDIA_QUEUE).toBe("pawket.media");
    expect(MEDIA_PROCESS_JOB).toBe("media.process-public-asset");
    expect(first.id).toBe(assetId);
    expect(first.data).toEqual({ assetId });
    expect(replay).toEqual(first);
    expect(JSON.stringify(first.data)).not.toMatch(
      /objectKey|versionId|signedUrl|filename|sourceBytes/iu,
    );
  });

  test("rejects malformed asset IDs before touching Valkey", async () => {
    const add = vi.fn();
    await expect(enqueueMediaAsset({ add }, "../not-an-asset")).rejects.toThrow(
      "Invalid public media asset job",
    );
    expect(add).not.toHaveBeenCalled();
  });

  test("accepts only the exact safe upload-completed payload", () => {
    const payload = {
      assetId: randomUUID(),
      ownerUserId: "creator-safe-001",
      purpose: "showcase",
    } as const;
    expect(parsePublicMediaCompletedPayload(payload)).toEqual(payload);
    expect(() =>
      parsePublicMediaCompletedPayload({ ...payload, objectKey: "quarantine/secret" }),
    ).toThrow("Invalid public media completion payload");
    expect(() =>
      parsePublicMediaCompletedPayload({ ...payload, purpose: "video" }),
    ).toThrow("Invalid public media completion payload");
  });
});
