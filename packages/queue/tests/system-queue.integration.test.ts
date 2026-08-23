import { randomUUID } from "node:crypto";

import { Worker } from "bullmq";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import {
  OUTBOX_JOB,
  SYSTEM_QUEUE,
  createQueueConnection,
  createWorkerConnection,
  createSystemQueue,
  enqueueSystemOutboxJob,
  type SystemOutboxJob,
} from "../src/index.js";

const valkeyUrl = process.env.TEST_VALKEY_URL;

if (!valkeyUrl) {
  throw new Error("TEST_VALKEY_URL is required for queue integration tests");
}

function isolatedValkeyUrl(source: string, database: number): string {
  const url = new URL(source);
  url.pathname = `/${database}`;
  return url.toString();
}

function jobPayload(outboxEventId = randomUUID()): SystemOutboxJob {
  return {
    outboxEventId,
    eventType: "system.foundation.ping.v1",
    eventVersion: 1,
    aggregateType: "system",
    aggregateId: "foundation",
    payload: { ping: true },
    occurredAt: "2026-08-23T08:00:00.000Z",
  };
}

async function waitForReady(connection: ReturnType<typeof createQueueConnection>): Promise<void> {
  if (connection.status === "ready") {
    return;
  }
  await new Promise<void>((resolve) => connection.once("ready", resolve));
}

async function waitForState(
  queue: ReturnType<typeof createSystemQueue>,
  jobId: string,
  expectedState: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    const job = await queue.getJob(jobId);
    if (job && (await job.getState()) === expectedState) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Job ${jobId} did not reach ${expectedState}`);
}

describe("system queue", () => {
  const queueUrl = isolatedValkeyUrl(valkeyUrl, 10);
  const connection = createQueueConnection(queueUrl);
  const queue = createSystemQueue(connection);
  let worker: Worker<SystemOutboxJob> | undefined;

  beforeAll(async () => {
    await waitForReady(connection);
    await connection.ping();
  });

  afterEach(async () => {
    if (worker) {
      await worker.close();
      worker = undefined;
    }
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue.close();
    await connection.quit();
  });

  test("duplicate outbox event IDs produce one retained job with delivery defaults", async () => {
    const payload = jobPayload();

    const first = await enqueueSystemOutboxJob(queue, payload);
    const duplicate = await enqueueSystemOutboxJob(queue, payload);

    expect(first.id).toBe(payload.outboxEventId);
    expect(duplicate.id).toBe(payload.outboxEventId);
    expect(await queue.getJobs(["wait", "active", "delayed", "completed", "failed"])).toHaveLength(
      1,
    );
    expect(first.opts).toEqual(
      expect.objectContaining({
        attempts: 8,
        backoff: { type: "exponential", delay: 1_000 },
        removeOnComplete: { age: 86_400, count: 10_000 },
        removeOnFail: false,
      }),
    );
  });

  test("producer commands fail bounded while worker blocking commands may retry", async () => {
    const workerConnection = createWorkerConnection(queueUrl);
    try {
      expect(connection.options.maxRetriesPerRequest).not.toBeNull();
      expect(connection.options.enableOfflineQueue).toBe(false);
      expect(workerConnection.options.maxRetriesPerRequest).toBeNull();
    } finally {
      workerConnection.disconnect();
    }
  });

  test("failed jobs remain available for manual inspection", async () => {
    const payload = jobPayload();
    worker = new Worker<SystemOutboxJob>(
      SYSTEM_QUEUE,
      async () => {
        throw new Error("deliberate queue test failure");
      },
      { connection: createWorkerConnection(queueUrl) },
    );

    await queue.add(OUTBOX_JOB, payload, {
      jobId: payload.outboxEventId,
      attempts: 1,
    });
    await waitForState(queue, payload.outboxEventId, "failed");

    const retained = await queue.getJob(payload.outboxEventId);
    expect(retained).toBeDefined();
    await expect(retained?.getState()).resolves.toBe("failed");
  });

  test("public add rejects every credential bypass before data reaches Valkey", async () => {
    const cyclicPayload: Record<string, unknown> = {};
    cyclicPayload.self = cyclicPayload;
    const bypasses: Array<{ label: string; payload: Record<string, unknown> }> = [
      { label: "auth", payload: { AUTH: "dummy-secret-auth" } },
      { label: "oauth", payload: { o_auth: "dummy-secret-oauth" } },
      { label: "api-key", payload: { "API-Key": "dummy-secret-api-key" } },
      { label: "access-key", payload: { access_key: "dummy-secret-access-key" } },
      {
        label: "username-url",
        payload: { link: "https://dummy-secret-user@example.invalid/path" },
      },
      {
        label: "query-credential",
        payload: { link: "https://example.invalid/path?access_token=dummy-secret-query" },
      },
      {
        label: "custom-to-json",
        payload: {
          profile: {
            toJSON() {
              return { authorization: "dummy-secret-to-json" };
            },
          },
        },
      },
      { label: "cycle", payload: cyclicPayload },
      { label: "non-serializable", payload: { amount: 1n } },
    ];

    for (const bypass of bypasses) {
      const payload = jobPayload();
      payload.payload = bypass.payload;
      const rejection = Promise.resolve().then(() =>
        queue.add(OUTBOX_JOB, payload, { jobId: payload.outboxEventId }),
      );
      await expect(rejection, bypass.label).rejects.toThrow("Unsafe outbox job data");
      await expect(rejection).rejects.not.toThrow("dummy-secret");
    }

    expect(await queue.getJobs(["wait", "active", "failed", "completed"])).toEqual([]);
  });

  test("public addBulk validates canonical JSON atomically", async () => {
    const benign = jobPayload();
    const unsafe = jobPayload();
    unsafe.payload = { nested: { OAuth: "dummy-secret-bulk" } };

    const rejection = Promise.resolve().then(() =>
        queue.addBulk([
          { name: OUTBOX_JOB, data: benign, opts: { jobId: benign.outboxEventId } },
          { name: OUTBOX_JOB, data: unsafe, opts: { jobId: unsafe.outboxEventId } },
        ]),
      );
    await expect(rejection).rejects.toThrow("Unsafe outbox job data");
    await expect(rejection).rejects.not.toThrow("dummy-secret-bulk");

    expect(await queue.getJobs(["wait", "active", "failed", "completed"])).toEqual([]);
  });

  test("benign custom JSON is canonicalized before enqueue", async () => {
    const payload = jobPayload();
    payload.payload = {
      artist: {
        ignoredPrototypeValue: "not serialized",
        toJSON() {
          return { displayName: "Benign Artist" };
        },
      },
    };

    await queue.add(OUTBOX_JOB, payload, { jobId: payload.outboxEventId });

    const stored = await queue.getJob(payload.outboxEventId);
    expect(stored?.data.payload).toEqual({ artist: { displayName: "Benign Artist" } });
  });
});
