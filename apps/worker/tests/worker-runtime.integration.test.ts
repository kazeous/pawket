import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, type Socket } from "node:net";

import { DelayedError, Queue } from "bullmq";

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import {
  acknowledgeOutboxEvent,
  createDatabase,
  insertOutboxEvent,
  systemOutbox,
} from "@pawket/database";
import {
  getRequestContext,
  metricsRegistry,
  type RequestContext,
} from "@pawket/observability";
import { PublicMediaWorkerRetryableError } from "@pawket/public-media";
import {
  createQueueConnection,
  createMediaQueue,
  createSystemQueue,
  dispatchOutboxBatch,
  MEDIA_PROCESS_JOB,
  OUTBOX_JOB,
  SYSTEM_QUEUE,
  type SystemOutboxJob,
} from "@pawket/queue";

import {
  createMediaJobProcessor,
  createWorkerJobProcessor,
  startWorker,
  type WorkerRuntimeDependencies,
} from "../src/worker-runtime.js";
import { createWorkerHealthState } from "../src/worker-health.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const valkeyUrl = process.env.TEST_VALKEY_URL;

if (!databaseUrl) {
  throw new Error("TEST_DATABASE_URL is required for worker integration tests");
}
if (!valkeyUrl) {
  throw new Error("TEST_VALKEY_URL is required for worker integration tests");
}

function isolatedValkeyUrl(source: string, database: number): string {
  const url = new URL(source);
  url.pathname = `/${database}`;
  return url.toString();
}

async function createSilentRedisPeer() {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Silent Redis peer did not bind a TCP port");
  }

  return {
    url: `redis://127.0.0.1:${address.port}`,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function waitForReady(connection: ReturnType<typeof createQueueConnection>): Promise<void> {
  if (connection.status === "ready") {
    return;
  }
  await new Promise<void>((resolve) => connection.once("ready", resolve));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("public media runtime handoff", () => {
  const logger = { info: vi.fn(), error: vi.fn() };

  function completionJob(assetId = randomUUID()): SystemOutboxJob {
    return {
      outboxEventId: randomUUID(),
      eventType: "media.public_upload_completed.v1",
      eventVersion: 1,
      aggregateType: "public_media_asset",
      aggregateId: assetId,
      payload: {
        assetId,
        ownerUserId: "creator-media-runtime-001",
        purpose: "showcase",
      },
      occurredAt: new Date("2026-08-30T08:00:00.000Z").toISOString(),
    };
  }

  test("enqueues the stable media job before acknowledging upload completion", async () => {
    const calls: string[] = [];
    const data = completionJob();
    const mediaQueue = {
      async add(name: string, jobData: { assetId: string }, options: { jobId: string }) {
        calls.push("enqueue");
        expect(name).toBe(MEDIA_PROCESS_JOB);
        expect(jobData).toEqual({ assetId: data.aggregateId });
        expect(options.jobId).toBe(data.aggregateId);
        return { id: options.jobId, data: jobData };
      },
    };
    const acknowledge = vi.fn(async () => {
      calls.push("acknowledge");
      return true;
    });
    const processor = createWorkerJobProcessor({
      logger,
      database: {} as never,
      acknowledge,
      mediaQueue,
    });

    await processor({ id: data.outboxEventId, name: OUTBOX_JOB, data } as never);

    expect(calls).toEqual(["enqueue", "acknowledge"]);
    expect(acknowledge).toHaveBeenCalledWith(expect.anything(), {
      eventId: data.outboxEventId,
    });
  });

  test("enqueue-before-ack replay uses the same harmless media identity", async () => {
    const data = completionJob();
    const jobIds: string[] = [];
    const mediaQueue = {
      async add(_name: string, jobData: { assetId: string }, options: { jobId: string }) {
        jobIds.push(options.jobId);
        return { id: options.jobId, data: jobData };
      },
    };
    const acknowledge = vi
      .fn()
      .mockRejectedValueOnce(new Error("simulated crash before acknowledgement"))
      .mockResolvedValueOnce(true);
    const processor = createWorkerJobProcessor({
      logger,
      database: {} as never,
      acknowledge,
      mediaQueue,
    });
    const job = { id: data.outboxEventId, name: OUTBOX_JOB, data } as never;

    await expect(processor(job)).rejects.toThrow("Worker job processing failed");
    await expect(processor(job)).resolves.toBeUndefined();

    expect(jobIds).toEqual([data.aggregateId, data.aggregateId]);
    expect(acknowledge).toHaveBeenCalledTimes(2);
  });

  test("rejects unsafe media completion payloads without enqueue or acknowledgement", async () => {
    const data = completionJob();
    data.payload = { ...data.payload, objectKey: "quarantine/private" };
    const mediaQueue = { add: vi.fn() };
    const acknowledge = vi.fn();
    const processor = createWorkerJobProcessor({
      logger,
      database: {} as never,
      acknowledge,
      mediaQueue,
    });

    await expect(
      processor({ id: data.outboxEventId, name: OUTBOX_JOB, data } as never),
    ).rejects.toThrow("Worker job processing failed");
    expect(mediaQueue.add).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
  });

  test("media job runtime accepts only the exact stable job contract", async () => {
    const assetId = randomUUID();
    const processAsset = vi.fn(async () => ({ assetId, state: "ready" as const }));
    const processor = createMediaJobProcessor({
      logger,
      database: {} as never,
      storage: {} as never,
      workerId: "runtime-worker:host-one:process-one",
      processAsset,
    });

    await processor({
      id: assetId,
      name: MEDIA_PROCESS_JOB,
      data: { assetId },
    } as never);
    expect(processAsset).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      assetId,
      expect.objectContaining({ workerId: "runtime-worker:host-one:process-one" }),
    );

    await expect(
      processor({
        id: randomUUID(),
        name: MEDIA_PROCESS_JOB,
        data: { assetId },
      } as never),
    ).rejects.toThrow("Invalid public media worker job");
    expect(processAsset).toHaveBeenCalledTimes(1);
  });

  test("an active PostgreSQL lease moves the BullMQ job to its exact retry timestamp", async () => {
    const assetId = randomUUID();
    const retryAt = new Date("2026-08-30T08:10:00.000Z");
    const moveToDelayed = vi.fn(async () => undefined);
    const processor = createMediaJobProcessor({
      logger,
      database: {} as never,
      storage: {} as never,
      workerId: "runtime-worker:lease-delay",
      processAsset: vi.fn(async () => {
        throw new PublicMediaWorkerRetryableError("processing_lease_active", retryAt);
      }),
    });

    await expect(
      processor({
        id: assetId,
        name: MEDIA_PROCESS_JOB,
        data: { assetId },
        token: "active-lock-token",
        moveToDelayed,
      } as never),
    ).rejects.toBeInstanceOf(DelayedError);
    expect(moveToDelayed).toHaveBeenCalledOnce();
    expect(moveToDelayed).toHaveBeenCalledWith(retryAt.getTime(), "active-lock-token");
  });

  test.each(["missing_token", "lost_lock"] as const)(
    "lease delay fails closed on %s without reporting completion",
    async (failureMode) => {
      const assetId = randomUUID();
      const moveToDelayed = vi.fn(async () => {
        if (failureMode === "lost_lock") throw new Error("dummy-secret-lock-error");
      });
      const processor = createMediaJobProcessor({
        logger,
        database: {} as never,
        storage: {} as never,
        workerId: "runtime-worker:lease-delay-failure",
        processAsset: vi.fn(async () => {
          throw new PublicMediaWorkerRetryableError(
            "processing_lease_active",
            new Date("2026-08-30T08:10:00.000Z"),
          );
        }),
      });

      await expect(
        processor({
          id: assetId,
          name: MEDIA_PROCESS_JOB,
          data: { assetId },
          ...(failureMode === "missing_token" ? {} : { token: "expired-lock-token" }),
          moveToDelayed,
        } as never),
      ).rejects.toThrow("Public media worker delay failed");
      if (failureMode === "missing_token") expect(moveToDelayed).not.toHaveBeenCalled();
    },
  );
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for test condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForJobState(
  queue: ReturnType<typeof createSystemQueue> | ReturnType<typeof createMediaQueue>,
  jobId: string,
  expectedState: string,
): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const job = await queue.getJob(jobId);
    if (job && (await job.getState()) === expectedState) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Job ${jobId} did not reach ${expectedState}`);
}

async function workerMetricSnapshot(
  outcome: "completed" | "failed",
  name = OUTBOX_JOB,
) {
  const counterMetric = metricsRegistry.getSingleMetric("pawket_worker_jobs_total");
  const durationMetric = metricsRegistry.getSingleMetric("pawket_worker_job_duration_seconds");
  if (!counterMetric || !durationMetric) {
    throw new Error("Worker metrics are not registered");
  }
  const counter = await counterMetric.get();
  const duration = await durationMetric.get();
  const labels = { queue: SYSTEM_QUEUE, name, outcome };
  const matchesLabels = (candidate: Record<string, string | number>) =>
    Object.entries(labels).every(([key, value]) => candidate[key] === value);

  return {
    jobs:
      counter.values.find((value) => matchesLabels(value.labels))?.value ?? 0,
    durations:
      duration.values.find(
        (value) =>
          value.metricName === "pawket_worker_job_duration_seconds_count" &&
          matchesLabels(value.labels),
      )?.value ?? 0,
  };
}

describe("outbox dispatcher", () => {
  const database = createDatabase(databaseUrl);
  const { db } = database;
  const connection = createQueueConnection(isolatedValkeyUrl(valkeyUrl, 11));
  const queue = createSystemQueue(connection);

  beforeAll(async () => {
    await waitForReady(connection);
    await connection.ping();
  });

  afterEach(async () => {
    await db.delete(systemOutbox);
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue.close();
    await connection.quit();
    await database.close();
  });

  async function insertFoundationEvent(now: Date): Promise<string> {
    return db.transaction((tx) =>
      insertOutboxEvent(tx, {
        eventType: "system.foundation.ping.v1",
        eventVersion: 1,
        aggregateType: "system",
        aggregateId: randomUUID(),
        payload: { ping: true },
        occurredAt: now,
        availableAt: now,
      }),
    );
  }

  test("successful enqueue keeps the claimed row leased and unpublished", async () => {
    const now = new Date();
    const eventId = await insertFoundationEvent(now);
    const enqueue = deferred<{ id: string }>();
    let addStarted = false;
    const controlledQueue = {
      add: vi.fn(() => {
        addStarted = true;
        return enqueue.promise;
      }),
    };

    const dispatch = dispatchOutboxBatch(
      { db, queue: controlledQueue },
      { workerId: "dispatcher-ordering", batchSize: 10, leaseMs: 30_000, now: () => now },
    );
    await waitUntil(() => addStarted);

    const [beforeAddCompletes] = await db.select().from(systemOutbox);
    expect(beforeAddCompletes?.publishedAt).toBeNull();

    enqueue.resolve({ id: eventId });
    await expect(dispatch).resolves.toEqual({ claimed: 1, enqueued: 1, failed: 0 });
    const [afterAddCompletes] = await db.select().from(systemOutbox);
    expect(afterAddCompletes).toEqual(
      expect.objectContaining({
        publishedAt: null,
        lockedBy: "dispatcher-ordering",
        leaseExpiresAt: new Date(now.getTime() + 30_000),
      }),
    );
  });

  test("queue failure releases the lease and schedules the event for retry", async () => {
    const now = new Date();
    await insertFoundationEvent(now);
    const unavailableQueue = {
      add: vi.fn(async () => {
        throw new Error("dummy-secret-error redis://dummy:dummy@127.0.0.1:1");
      }),
    };

    await expect(
      dispatchOutboxBatch(
        { db, queue: unavailableQueue },
        { workerId: "dispatcher-failure", batchSize: 10, leaseMs: 30_000, now: () => now },
      ),
    ).resolves.toEqual({ claimed: 1, enqueued: 0, failed: 1 });

    const [failed] = await db.select().from(systemOutbox);
    expect(failed).toEqual(
      expect.objectContaining({
        publishedAt: null,
        lockedAt: null,
        lockedBy: null,
        leaseExpiresAt: null,
        lastError: "outbox_delivery_failed",
        availableAt: new Date(now.getTime() + 1_000),
      }),
    );
  });

  test("forbidden nested payload data is rejected before enqueue with a safe category", async () => {
    const now = new Date();
    const unsafePayload = {
      profile: { apiToken: "dummy-secret-token" },
      callback: "postgresql://dummy:dummy@database.invalid/pawket",
    };
    const repositoryRejection = db.transaction((tx) =>
      insertOutboxEvent(tx, {
        eventType: "system.foundation.ping.v1",
        eventVersion: 1,
        aggregateType: "system",
        aggregateId: randomUUID(),
        payload: unsafePayload,
        occurredAt: now,
        availableAt: now,
      }),
    );
    await expect(repositoryRejection).rejects.toThrow("Unsafe outbox data");
    await expect(repositoryRejection).rejects.not.toThrow("dummy-secret-token");

    // Simulate a legacy or externally inserted row to prove the queue boundary is independent.
    const eventId = randomUUID();
    await db.insert(systemOutbox).values({
      id: eventId,
      eventType: "system.foundation.ping.v1",
      eventVersion: 1,
      aggregateType: "system",
      aggregateId: randomUUID(),
      payload: unsafePayload,
      occurredAt: now,
      availableAt: now,
    });

    await expect(
      dispatchOutboxBatch(
        { db, queue },
        {
          workerId: "dispatcher-sensitive-payload",
          batchSize: 10,
          leaseMs: 30_000,
          now: () => now,
        },
      ),
    ).resolves.toEqual({ claimed: 1, enqueued: 0, failed: 1 });

    expect(await queue.getJob(eventId)).toBeUndefined();
    const [failed] = await db.select().from(systemOutbox);
    expect(failed?.lastError).toBe("outbox_payload_rejected");
    expect(JSON.stringify(await queue.getJobs(["wait", "failed", "completed"]))).not.toContain(
      "dummy-secret-token",
    );
  });

  test("a disconnected producer schedules retry without hanging in the offline queue", async () => {
    const now = new Date();
    await insertFoundationEvent(now);
    const unavailableConnection = createQueueConnection("redis://127.0.0.1:1");
    unavailableConnection.on("error", () => undefined);
    const unavailableQueue = createSystemQueue(unavailableConnection);
    const dispatch = dispatchOutboxBatch(
      { db, queue: unavailableQueue },
      {
        workerId: "dispatcher-offline-valkey",
        batchSize: 10,
        leaseMs: 30_000,
        now: () => now,
      },
    );

    const outcome = await Promise.race([
      dispatch,
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 1_500)),
    ]);
    if (outcome === "timed-out") {
      unavailableConnection.disconnect();
      await dispatch.catch(() => undefined);
    }
    await unavailableQueue.close().catch(() => undefined);
    unavailableConnection.disconnect();

    expect(outcome).toEqual({ claimed: 1, enqueued: 0, failed: 1 });
    const [failed] = await db.select().from(systemOutbox);
    expect(failed).toEqual(
      expect.objectContaining({
        publishedAt: null,
        lockedAt: null,
        lockedBy: null,
        leaseExpiresAt: null,
        availableAt: new Date(now.getTime() + 1_000),
      }),
    );
  });

  test("a silent Redis peer cannot hold enqueue beyond its operation deadline", async () => {
    const now = new Date();
    await insertFoundationEvent(now);
    const silentPeer = await createSilentRedisPeer();
    const silentConnection = createQueueConnection(silentPeer.url);
    silentConnection.on("error", () => undefined);
    const silentQueue = createSystemQueue(silentConnection);
    silentQueue.on("error", () => undefined);
    const startedAt = Date.now();
    const dispatch = dispatchOutboxBatch(
      { db, queue: silentQueue },
      {
        workerId: "dispatcher-silent-valkey",
        batchSize: 10,
        leaseMs: 30_000,
        enqueueTimeoutMs: 150,
        now: () => now,
      },
    );
    const outcome = await Promise.race([
      dispatch,
      new Promise<"test-timeout">((resolve) => setTimeout(() => resolve("test-timeout"), 750)),
    ]);
    const elapsedMs = Date.now() - startedAt;

    silentConnection.disconnect();
    await silentQueue.disconnect().catch(() => undefined);
    await silentPeer.close();
    await dispatch.catch(() => undefined);

    expect(outcome).toEqual({ claimed: 1, enqueued: 0, failed: 1 });
    expect(elapsedMs).toBeLessThan(750);
    const [failed] = await db.select().from(systemOutbox);
    expect(failed).toEqual(
      expect.objectContaining({
        lastError: "outbox_delivery_failed",
        lockedAt: null,
        lockedBy: null,
        leaseExpiresAt: null,
      }),
    );
  });

});

describe("worker runtime integration", () => {
  const database = createDatabase(databaseUrl);
  const { db } = database;
  const runtimeUrl = isolatedValkeyUrl(valkeyUrl, 12);
  const inspectionConnection = createQueueConnection(runtimeUrl);
  const inspectionQueue = createSystemQueue(inspectionConnection);
  const inspectionMediaQueue = createMediaQueue(inspectionConnection);
  const handles: Array<{ stop(): Promise<void> }> = [];

  beforeAll(async () => {
    await waitForReady(inspectionConnection);
  });

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.stop()));
    await db.delete(systemOutbox);
    await inspectionQueue.obliterate({ force: true });
    await inspectionMediaQueue.obliterate({ force: true });
  });

  afterAll(async () => {
    await inspectionQueue.close();
    await inspectionMediaQueue.close();
    await inspectionConnection.quit();
    await database.close();
  });

  test("a silent Redis peer cannot hold producer startup beyond its operation deadline", async () => {
    const silentPeer = await createSilentRedisPeer();
    const startup = startWorker({
      databaseUrl,
      valkeyUrl: silentPeer.url,
      concurrency: 1,
      batchSize: 10,
      leaseMs: 30_000,
      producerOperationTimeoutMs: 150,
      signalSource: new EventEmitter(),
      logger: { info() {}, error() {} },
    });
    const outcome = await Promise.race([
      startup.then(
        () => "started" as const,
        (error: unknown) => error,
      ),
      new Promise<"test-timeout">((resolve) => setTimeout(() => resolve("test-timeout"), 750)),
    ]);

    await silentPeer.close();
    await startup.catch(() => undefined);

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("Worker startup failed");
  });

  test("a foundation ping is published once and completed by the BullMQ worker", async () => {
    const metricsBefore = await workerMetricSnapshot("completed");
    const now = new Date();
    const eventId = await db.transaction((tx) =>
      insertOutboxEvent(tx, {
        eventType: "system.foundation.ping.v1",
        eventVersion: 1,
        aggregateType: "system",
        aggregateId: randomUUID(),
        payload: { ping: true },
        occurredAt: now,
        availableAt: now,
      }),
    );
    const signalSource = new EventEmitter();
    const handle = await startWorker({
      databaseUrl,
      valkeyUrl: runtimeUrl,
      concurrency: 1,
      batchSize: 10,
      leaseMs: 30_000,
      signalSource,
    });
    handles.push(handle);

    await waitForJobState(inspectionQueue, eventId, "completed");

    expect(await inspectionQueue.getJobs(["completed", "failed", "wait", "active"])).toHaveLength(
      1,
    );
    const row = (await db.select().from(systemOutbox)).find((event) => event.id === eventId);
    expect(row?.publishedAt).not.toBeNull();
    const metricsAfter = await workerMetricSnapshot("completed");
    expect(metricsAfter.jobs - metricsBefore.jobs).toBe(1);
    expect(metricsAfter.durations - metricsBefore.durations).toBe(1);
  });

  test("the eighth caught media failure completes in BullMQ without a ninth call", async () => {
    const assetId = randomUUID();
    const observedWorkerIds: string[] = [];
    const processMediaAsset = vi.fn<WorkerRuntimeDependencies["processMediaAsset"]>(
      async (_database, _storage, observedAssetId, processOptions) => {
        expect(observedAssetId).toBe(assetId);
        observedWorkerIds.push(processOptions.workerId ?? "");
        if (observedWorkerIds.length < 8) throw new Error("simulated caught media failure");
        return { assetId, state: "failed", failureCode: "processing_error" };
      },
    );
    const workerUuid = "11111111-1111-4111-8111-111111111111";
    const handle = await startWorker({
      databaseUrl,
      valkeyUrl: runtimeUrl,
      concurrency: 1,
      batchSize: 10,
      leaseMs: 30_000,
      signalSource: new EventEmitter(),
      publicMedia: { storage: {} as never, concurrency: 1 },
      dependencies: {
        processMediaAsset,
        hostname: () => "media-runtime-host",
        randomUUID: () => workerUuid,
      },
      logger: { info() {}, error() {} },
    });
    handles.push(handle);
    await inspectionMediaQueue.add(
      MEDIA_PROCESS_JOB,
      { assetId },
      {
        jobId: assetId,
        attempts: 8,
        backoff: { type: "fixed", delay: 1 },
        removeOnComplete: false,
        removeOnFail: false,
      },
    );

    await waitForJobState(inspectionMediaQueue, assetId, "completed");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(processMediaAsset).toHaveBeenCalledTimes(8);
    expect(new Set(observedWorkerIds)).toEqual(
      new Set([`media-runtime-host:${workerUuid}`]),
    );
    expect((await inspectionMediaQueue.getJob(assetId))?.attemptsMade).toBe(8);
  });

  test("a lost Valkey job is redispatched after lease expiry and acknowledged after handling", async () => {
    const firstDispatchAt = new Date();
    const eventId = await db.transaction((tx) =>
      insertOutboxEvent(tx, {
        eventType: "system.foundation.ping.v1",
        eventVersion: 1,
        aggregateType: "system",
        aggregateId: randomUUID(),
        payload: { ping: true },
        occurredAt: firstDispatchAt,
        availableAt: firstDispatchAt,
      }),
    );

    await expect(
      dispatchOutboxBatch(
        { db, queue: inspectionQueue },
        {
          workerId: "dispatcher-before-loss",
          batchSize: 1,
          leaseMs: 5_000,
          now: () => firstDispatchAt,
        },
      ),
    ).resolves.toEqual({ claimed: 1, enqueued: 1, failed: 0 });
    expect((await db.select().from(systemOutbox))[0]?.publishedAt).toBeNull();

    const lostJob = await inspectionQueue.getJob(eventId);
    expect(lostJob).toBeDefined();
    await lostJob?.remove();
    expect(await inspectionQueue.getJob(eventId)).toBeUndefined();

    await expect(
      dispatchOutboxBatch(
        { db, queue: inspectionQueue },
        {
          workerId: "dispatcher-after-loss",
          batchSize: 1,
          leaseMs: 5_000,
          now: () => new Date(firstDispatchAt.getTime() + 5_000),
        },
      ),
    ).resolves.toEqual({ claimed: 1, enqueued: 1, failed: 0 });

    const signalSource = new EventEmitter();
    const handle = await startWorker({
      databaseUrl,
      valkeyUrl: runtimeUrl,
      concurrency: 1,
      batchSize: 10,
      leaseMs: 5_000,
      signalSource,
    });
    handles.push(handle);
    await waitForJobState(inspectionQueue, eventId, "completed");

    const row = (await db.select().from(systemOutbox)).find((event) => event.id === eventId);
    expect(row?.publishedAt).not.toBeNull();
  });

  test("database acknowledgement failure retries handling without exposing the database error", async () => {
    const now = new Date();
    const eventId = await db.transaction((tx) =>
      insertOutboxEvent(tx, {
        eventType: "system.foundation.ping.v1",
        eventVersion: 1,
        aggregateType: "system",
        aggregateId: randomUUID(),
        payload: { ping: true },
        occurredAt: now,
        availableAt: now,
      }),
    );
    await dispatchOutboxBatch(
      { db, queue: inspectionQueue },
      {
        workerId: "dispatcher-ack-retry",
        batchSize: 1,
        leaseMs: 30_000,
        now: () => now,
      },
    );
    const acknowledge = vi
      .fn<typeof acknowledgeOutboxEvent>()
      .mockRejectedValueOnce(
        new Error("dummy-secret-database-error postgresql://dummy:dummy@database.invalid/pawket"),
      )
      .mockImplementation(acknowledgeOutboxEvent);
    const signalSource = new EventEmitter();
    const handle = await startWorker({
      databaseUrl,
      valkeyUrl: runtimeUrl,
      concurrency: 1,
      batchSize: 10,
      leaseMs: 30_000,
      signalSource,
      dependencies: { acknowledge },
      logger: { info() {}, error() {} },
    });
    handles.push(handle);

    await waitForJobState(inspectionQueue, eventId, "completed");

    expect(acknowledge).toHaveBeenCalledTimes(2);
    const completed = await inspectionQueue.getJob(eventId);
    expect(completed?.attemptsMade).toBe(2);
    expect(JSON.stringify(completed)).not.toContain("dummy-secret-database-error");
    expect(JSON.stringify(completed)).not.toContain("postgresql://");
    const row = (await db.select().from(systemOutbox)).find((event) => event.id === eventId);
    expect(row?.publishedAt).not.toBeNull();
  });

  test("redispatch reactivates a terminal failed job while PostgreSQL is unpublished", async () => {
    const firstDispatchAt = new Date();
    const aggregateId = randomUUID();
    const eventId = await db.transaction((tx) =>
      insertOutboxEvent(tx, {
        eventType: "system.foundation.ping.v1",
        eventVersion: 1,
        aggregateType: "system",
        aggregateId,
        payload: { ping: true },
        occurredAt: firstDispatchAt,
        availableAt: firstDispatchAt,
      }),
    );
    await inspectionQueue.add(
      OUTBOX_JOB,
      {
        outboxEventId: eventId,
        eventType: "system.foundation.ping.v1",
        eventVersion: 1,
        aggregateType: "system",
        aggregateId,
        payload: { ping: true },
        occurredAt: firstDispatchAt.toISOString(),
      },
      { jobId: eventId, attempts: 1, removeOnFail: false },
    );
    await dispatchOutboxBatch(
      { db, queue: inspectionQueue },
      {
        workerId: "dispatcher-before-terminal-failure",
        batchSize: 1,
        leaseMs: 5_000,
        now: () => firstDispatchAt,
      },
    );

    const failingHandle = await startWorker({
      databaseUrl,
      valkeyUrl: runtimeUrl,
      concurrency: 1,
      batchSize: 10,
      leaseMs: 5_000,
      signalSource: new EventEmitter(),
      dependencies: {
        acknowledge: vi.fn(async () => {
          throw new Error("dummy-secret-terminal-ack-failure");
        }),
      },
      logger: { info() {}, error() {} },
    });
    await waitForJobState(inspectionQueue, eventId, "failed");
    await failingHandle.stop();

    const failedBeforeRetry = await inspectionQueue.getJob(eventId);
    expect(failedBeforeRetry?.failedReason).toBe("Worker job processing failed");
    expect(failedBeforeRetry?.stacktrace.length).toBeGreaterThan(0);
    expect((await db.select().from(systemOutbox))[0]?.publishedAt).toBeNull();

    await expect(
      dispatchOutboxBatch(
        { db, queue: inspectionQueue },
        {
          workerId: "dispatcher-after-terminal-failure",
          batchSize: 1,
          leaseMs: 5_000,
          now: () => new Date(firstDispatchAt.getTime() + 5_000),
        },
      ),
    ).resolves.toEqual({ claimed: 1, enqueued: 1, failed: 0 });
    await waitForJobState(inspectionQueue, eventId, "waiting");

    const handle = await startWorker({
      databaseUrl,
      valkeyUrl: runtimeUrl,
      concurrency: 1,
      batchSize: 10,
      leaseMs: 5_000,
      signalSource: new EventEmitter(),
    });
    handles.push(handle);
    await waitForJobState(inspectionQueue, eventId, "completed");

    const row = (await db.select().from(systemOutbox)).find((event) => event.id === eventId);
    expect(row?.publishedAt).not.toBeNull();
  });

  test("an unknown event type fails visibly and remains retained", async () => {
    const metricsBefore = await workerMetricSnapshot("failed");
    const observedContexts: Array<RequestContext | undefined> = [];
    const logOutput: string[] = [];
    const signalSource = new EventEmitter();
    const handle = await startWorker({
      databaseUrl,
      valkeyUrl: runtimeUrl,
      concurrency: 1,
      batchSize: 10,
      leaseMs: 30_000,
      signalSource,
      logger: {
        info() {},
        error(data, message) {
          observedContexts.push(getRequestContext());
          logOutput.push(JSON.stringify({ data, message }));
        },
      },
    });
    handles.push(handle);
    const outboxEventId = randomUUID();
    const unknownEventType = "system.unknown.v1 dummy-secret-value";
    const payload: SystemOutboxJob = {
      outboxEventId,
      eventType: unknownEventType,
      eventVersion: 1,
      aggregateType: "system",
      aggregateId: randomUUID(),
      payload: {},
      occurredAt: new Date().toISOString(),
    };

    await inspectionQueue.add(OUTBOX_JOB, payload, {
      jobId: outboxEventId,
      attempts: 1,
      removeOnFail: false,
    });
    await waitForJobState(inspectionQueue, outboxEventId, "failed");

    const retained = await inspectionQueue.getJob(outboxEventId);
    expect(retained).toBeDefined();
    expect(retained?.failedReason).toContain("Unsupported outbox event type");
    expect(retained?.failedReason).not.toContain("dummy-secret-value");
    expect(logOutput.join("\n")).not.toContain(unknownEventType);
    expect(logOutput.join("\n")).not.toContain("dummy-secret-value");
    expect(observedContexts).toContainEqual({
      requestId: outboxEventId,
      outboxEventId,
      jobId: outboxEventId,
    });
    const metricsAfter = await workerMetricSnapshot("failed");
    expect(metricsAfter.jobs - metricsBefore.jobs).toBe(1);
    expect(metricsAfter.durations - metricsBefore.durations).toBe(1);
  });

  test("a BullMQ job ID mismatch fails before outbox acknowledgement", async () => {
    const mismatchId = randomUUID();
    const now = new Date();
    const availableAt = new Date(now.getTime() + 60_000);
    const eventId = await db.transaction((tx) =>
      insertOutboxEvent(tx, {
        eventType: "system.foundation.ping.v1",
        eventVersion: 1,
        aggregateType: "system",
        aggregateId: randomUUID(),
        payload: { ping: true },
        occurredAt: now,
        availableAt,
      }),
    );
    const rawQueue = new Queue<SystemOutboxJob>(SYSTEM_QUEUE, {
      connection: inspectionConnection,
    });
    const acknowledge = vi.fn<typeof acknowledgeOutboxEvent>();
    const handle = await startWorker({
      databaseUrl,
      valkeyUrl: runtimeUrl,
      concurrency: 1,
      batchSize: 10,
      leaseMs: 30_000,
      signalSource: new EventEmitter(),
      dependencies: { acknowledge },
      logger: { info() {}, error() {} },
    });
    handles.push(handle);

    try {
      await rawQueue.add(
        OUTBOX_JOB,
        {
          outboxEventId: eventId,
          eventType: "system.foundation.ping.v1",
          eventVersion: 1,
          aggregateType: "system",
          aggregateId: randomUUID(),
          payload: { ping: true },
          occurredAt: now.toISOString(),
        },
        { jobId: mismatchId, attempts: 1, removeOnFail: false },
      );
      await waitForJobState(inspectionQueue, mismatchId, "failed");

      const retained = await inspectionQueue.getJob(mismatchId);
      expect(retained?.failedReason).toBe("Outbox job ID does not match outbox event ID");
      expect(acknowledge).not.toHaveBeenCalled();
      const row = (await db.select().from(systemOutbox)).find((event) => event.id === eventId);
      expect(row?.publishedAt).toBeNull();
    } finally {
      await rawQueue.close();
    }
  });

  test("unsupported BullMQ names share one fixed metric label", async () => {
    const metricsBefore = await workerMetricSnapshot("failed", "unsupported");
    const signalSource = new EventEmitter();
    const handle = await startWorker({
      databaseUrl,
      valkeyUrl: runtimeUrl,
      concurrency: 1,
      batchSize: 10,
      leaseMs: 30_000,
      signalSource,
      logger: { info() {}, error() {} },
    });
    handles.push(handle);
    const arbitraryNames = ["attacker.dynamic.one", "attacker.dynamic.two"];

    for (const name of arbitraryNames) {
      const outboxEventId = randomUUID();
      await inspectionQueue.add(
        name,
        {
          outboxEventId,
          eventType: "system.foundation.ping.v1",
          eventVersion: 1,
          aggregateType: "system",
          aggregateId: randomUUID(),
          payload: {},
          occurredAt: new Date().toISOString(),
        },
        { jobId: outboxEventId, attempts: 1, removeOnFail: false },
      );
      await waitForJobState(inspectionQueue, outboxEventId, "failed");
    }

    const metricsAfter = await workerMetricSnapshot("failed", "unsupported");
    expect(metricsAfter.jobs - metricsBefore.jobs).toBe(2);
    expect(metricsAfter.durations - metricsBefore.durations).toBe(2);
    const counterMetric = metricsRegistry.getSingleMetric("pawket_worker_jobs_total");
    if (!counterMetric) throw new Error("Worker counter is not registered");
    const metricNames = (await counterMetric.get()).values.map((value) => value.labels.name);
    expect(metricNames).not.toContain(arbitraryNames[0]);
    expect(metricNames).not.toContain(arbitraryNames[1]);
  });
});

describe("worker shutdown", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function runtimeDoubles(
    options: {
      workerClose?: (force?: boolean) => Promise<void>;
      workerDisconnect?: () => Promise<void>;
      queueClose?: () => Promise<void>;
      queueDisconnect?: () => Promise<void>;
      producerQuit?: () => Promise<void>;
      producerConnect?: () => Promise<void>;
      producerDisconnect?: () => void;
      workerQuit?: () => Promise<void>;
      workerConnect?: () => Promise<void>;
      workerConnectionDisconnect?: () => void;
      databaseClose?: () => Promise<void>;
      onWorkerConnectionCreate?: () => void;
      hostname?: () => string;
      randomUUID?: () => string;
      throwAt?:
        | "producer"
        | "worker-connection"
        | "worker-connect"
        | "queue"
        | "worker";
    } = {},
  ) {
    const calls: string[] = [];
    const acquisitions: string[] = [];
    const signalSource = new EventEmitter();
    const dispatch = vi.fn(async () => ({ claimed: 0, enqueued: 0, failed: 0 }));

    return {
      calls,
      acquisitions,
      dispatch,
      signalSource,
      dependencies: {
        createDatabase: () => {
          acquisitions.push("postgres");
          return {
            db: {},
            close:
              options.databaseClose ??
              (async () => {
                calls.push("postgres");
              }),
          };
        },
        createProducerConnection: () => {
          if (options.throwAt === "producer") {
            throw new Error("dummy-secret-producer-factory");
          }
          acquisitions.push("producer-valkey");
          return {
            connect: options.producerConnect ?? (async () => undefined),
            quit:
              options.producerQuit ??
              (async () => {
                calls.push("producer-valkey");
              }),
            disconnect:
              options.producerDisconnect ??
              (() => {
                calls.push("producer-valkey-force");
              }),
          };
        },
        createWorkerConnection: () => {
          options.onWorkerConnectionCreate?.();
          if (options.throwAt === "worker-connection") {
            throw new Error("dummy-secret-worker-connection-factory");
          }
          acquisitions.push("worker-valkey");
          return {
            connect:
              options.workerConnect ??
              (async () => {
                if (options.throwAt === "worker-connect") {
                  throw new Error("dummy-secret-worker-connect");
                }
              }),
            quit:
              options.workerQuit ??
              (async () => {
                calls.push("worker-valkey");
              }),
            disconnect:
              options.workerConnectionDisconnect ??
              (() => {
                calls.push("worker-valkey-force");
              }),
          };
        },
        createQueue: () => {
          if (options.throwAt === "queue") {
            throw new Error("dummy-secret-queue-factory");
          }
          acquisitions.push("queue");
          return {
            close:
              options.queueClose ??
              (async () => {
                calls.push("queue");
              }),
            disconnect:
              options.queueDisconnect ??
              (async () => {
                calls.push("queue-force");
              }),
          };
        },
        createMediaQueue: () => {
          acquisitions.push("media-queue");
          return {
            close: async () => {
              calls.push("media-queue");
            },
            disconnect: async () => {
              calls.push("media-queue-force");
            },
          };
        },
        createWorker: () => {
          if (options.throwAt === "worker") {
            throw new Error("dummy-secret-worker-factory");
          }
          acquisitions.push("worker");
          return {
            close:
              options.workerClose ??
              (async () => {
                calls.push("worker");
              }),
            disconnect:
              options.workerDisconnect ??
              (async () => {
                calls.push("worker-force");
              }),
          };
        },
        createMediaWorker: () => {
          acquisitions.push("media-worker");
          return {
            close: async () => {
              calls.push("media-worker");
            },
            disconnect: async () => {
              calls.push("media-worker-force");
            },
          };
        },
        processMediaAsset: vi.fn(),
        hostname: options.hostname ?? (() => "test-worker-host"),
        randomUUID: options.randomUUID ?? (() => randomUUID()),
        dispatch,
      } as unknown as Partial<WorkerRuntimeDependencies>,
    };
  }

  test("public-media runtime acquires and closes its worker before shared resources", async () => {
    const doubles = runtimeDoubles();
    const handle = await startWorker({
      databaseUrl: "postgresql://unused:unused@127.0.0.1:5432/unused",
      valkeyUrl: "redis://127.0.0.1:6379/15",
      concurrency: 1,
      batchSize: 10,
      leaseMs: 30_000,
      signalSource: doubles.signalSource,
      dependencies: doubles.dependencies,
      publicMedia: { storage: {} as never, concurrency: 2 },
    });

    await handle.stop();

    expect(doubles.acquisitions).toEqual([
      "postgres",
      "producer-valkey",
      "worker-valkey",
      "queue",
      "media-queue",
      "worker",
      "media-worker",
    ]);
    expect(doubles.calls).toEqual([
      "media-worker",
      "worker",
      "media-queue",
      "queue",
      "producer-valkey",
      "worker-valkey",
      "postgres",
    ]);
  });

  test("runs bounded public-media cleanup scans periodically and records freshness", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T00:00:00.000Z"));
    const doubles = runtimeDoubles();
    const healthState = createWorkerHealthState();
    const oldestEligibleAt = new Date("2026-08-20T00:00:00.000Z");
    const cleanupCalls: unknown[] = [];
    const runMediaCleanup = vi.fn(async (input: unknown) => {
      cleanupCalls.push(input);
      return {
        results: [],
        counts: {
          processed_source: { candidate: 0, protected: 0, processed: 0, failed: 0 },
          failed_quarantine: { candidate: 0, protected: 0, processed: 0, failed: 0 },
          ready_unreferenced: { candidate: 1, protected: 1, processed: 0, failed: 0 },
          superseded_derivative: { candidate: 0, protected: 0, processed: 0, failed: 0 },
        },
        candidateCount: 1,
        protectedCount: 1,
        processedCount: 0,
        failedCount: 0,
        oldestEligibleAt,
      };
    });
    const storage = {} as never;
    const holds = { protectedAssetIds: vi.fn(async () => new Set<string>()) };
    const dependencies = {
      ...doubles.dependencies,
      scanRefundWindows: vi.fn(async () => ({
        dueSoon: 0,
        dueToday: 0,
        overdue: 0,
        attention: 0,
        outstandingAmountVnd: 0,
      })),
      readBacklogMetrics: vi.fn(async () => ({
        outbox: { pending: 0, oldestAgeSeconds: 0 },
        email: { pending: 0, oldestAgeSeconds: 0, attention: 0 },
      })),
      runMediaCleanup,
    } as Partial<WorkerRuntimeDependencies>;
    const handle = await startWorker({
      databaseUrl: "postgresql://unused:unused@127.0.0.1:5432/unused",
      valkeyUrl: "redis://127.0.0.1:6379/15",
      concurrency: 1,
      batchSize: 10,
      leaseMs: 30_000,
      signalSource: doubles.signalSource,
      dependencies,
      healthState,
      publicMedia: {
        storage,
        concurrency: 2,
        cleanup: {
          holds,
          mode: "report_only",
          retentionMode: "report_only",
          globalPause: false,
          batchSize: 25,
          scanIntervalMs: 60_000,
        },
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(cleanupCalls).toHaveLength(1);
    expect(cleanupCalls[0]).toEqual(expect.objectContaining({
      storage,
      holds,
      mode: "report_only",
      retentionMode: "report_only",
      globalPause: false,
      batchSize: 25,
    }));
    expect(healthState.lastPublicMediaCleanupScanSucceededAt).toBe(Date.now());
    expect(healthState.oldestPublicMediaCleanupCandidateAt).toBe(oldestEligibleAt.getTime());

    await vi.advanceTimersByTimeAsync(59_999);
    expect(cleanupCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(cleanupCalls).toHaveLength(2);

    await handle.stop();
  });

  test("marks public-media cleanup failure unhealthy without logging provider secrets", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T00:00:00.000Z"));
    const doubles = runtimeDoubles();
    const healthState = createWorkerHealthState();
    const logOutput: string[] = [];
    const handle = await startWorker({
      databaseUrl: "postgresql://unused:unused@127.0.0.1:5432/unused",
      valkeyUrl: "redis://127.0.0.1:6379/15",
      concurrency: 1,
      batchSize: 10,
      leaseMs: 30_000,
      signalSource: doubles.signalSource,
      dependencies: {
        ...doubles.dependencies,
        scanRefundWindows: vi.fn(async () => ({
          dueSoon: 0,
          dueToday: 0,
          overdue: 0,
          attention: 0,
          outstandingAmountVnd: 0,
        })),
        readBacklogMetrics: vi.fn(async () => ({
          outbox: { pending: 0, oldestAgeSeconds: 0 },
          email: { pending: 0, oldestAgeSeconds: 0, attention: 0 },
        })),
        runMediaCleanup: vi.fn(async () => {
          throw new Error("dummy-secret-source-key-version");
        }),
      } as Partial<WorkerRuntimeDependencies>,
      healthState,
      logger: {
        info() {},
        error(data, message) {
          logOutput.push(JSON.stringify({ data, message }));
        },
      },
      publicMedia: {
        storage: {} as never,
        concurrency: 2,
        cleanup: {
          holds: { protectedAssetIds: vi.fn(async () => new Set<string>()) },
          mode: "report_only",
          retentionMode: "report_only",
          globalPause: false,
          batchSize: 25,
          scanIntervalMs: 60_000,
        },
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    await handle.stop();

    expect(healthState.publicMediaCleanupConfigured).toBe(true);
    expect(healthState.lastPublicMediaCleanupScanSucceededAt).toBeNull();
    expect(logOutput.join("\n")).toContain("public_media_cleanup_scan_failed");
    expect(logOutput.join("\n")).not.toContain("dummy-secret-source-key-version");
  });

  test("SIGTERM stops polling and closes BullMQ before Valkey and PostgreSQL", async () => {
    vi.useFakeTimers();
    const doubles = runtimeDoubles();
    const handle = await startWorker({
      databaseUrl: "postgresql://unused:unused@127.0.0.1:5432/unused",
      valkeyUrl: "redis://127.0.0.1:6379/15",
      concurrency: 1,
      batchSize: 10,
      leaseMs: 30_000,
      signalSource: doubles.signalSource,
      dependencies: doubles.dependencies,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(doubles.dispatch).toHaveBeenCalledTimes(1);

    doubles.signalSource.emit("SIGTERM");
    await handle.whenStopped;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(doubles.dispatch).toHaveBeenCalledTimes(1);
    expect(doubles.calls).toEqual([
      "worker",
      "queue",
      "producer-valkey",
      "worker-valkey",
      "postgres",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("polling errors log a fixed category without raw secrets or URLs", async () => {
    vi.useFakeTimers();
    const doubles = runtimeDoubles();
    doubles.dispatch.mockRejectedValueOnce(
      new Error("dummy-secret-error redis://dummy:dummy@127.0.0.1:6379"),
    );
    const logOutput: string[] = [];
    const handle = await startWorker({
      databaseUrl: "postgresql://unused:unused@127.0.0.1:5432/unused",
      valkeyUrl: "redis://127.0.0.1:6379/15",
      concurrency: 1,
      batchSize: 10,
      leaseMs: 30_000,
      signalSource: doubles.signalSource,
      dependencies: doubles.dependencies,
      logger: {
        info() {},
        error(data, message) {
          logOutput.push(JSON.stringify({ data, message }));
        },
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    await handle.stop();

    expect(logOutput.join("\n")).toContain("outbox_poll_failed");
    expect(logOutput.join("\n")).not.toContain("dummy-secret-error");
    expect(logOutput.join("\n")).not.toContain("redis://");
  });

  test("producer startup failure closes created resources before creating worker Valkey", async () => {
    const doubles = runtimeDoubles({
      producerConnect: async () => {
        throw new Error("dummy-secret-startup redis://dummy:dummy@127.0.0.1:1");
      },
      onWorkerConnectionCreate: () => {
        doubles.calls.push("worker-valkey-created");
      },
    });

    await expect(
      startWorker({
        databaseUrl: "postgresql://unused:unused@127.0.0.1:5432/unused",
        valkeyUrl: "redis://127.0.0.1:1",
        concurrency: 1,
        batchSize: 10,
        leaseMs: 30_000,
        signalSource: doubles.signalSource,
        dependencies: doubles.dependencies,
        logger: { info() {}, error() {} },
      }),
    ).rejects.toThrow("Worker startup failed");

    expect(doubles.calls).toEqual(["producer-valkey-force", "postgres"]);
  });

  test.each([
    ["producer", ["postgres"]],
    ["worker-connection", ["producer-valkey-force", "postgres"]],
    [
      "worker-connect",
      ["worker-valkey-force", "producer-valkey-force", "postgres"],
    ],
    [
      "queue",
      ["worker-valkey-force", "producer-valkey-force", "postgres"],
    ],
    [
      "worker",
      [
        "queue-force",
        "worker-valkey-force",
        "producer-valkey-force",
        "postgres",
      ],
    ],
  ] as const)(
    "startup failure at %s unwinds every acquired resource",
    async (throwAt, expectedCalls) => {
      const doubles = runtimeDoubles({ throwAt });

      await expect(
        startWorker({
          databaseUrl: "postgresql://unused:unused@127.0.0.1:5432/unused",
          valkeyUrl: "redis://127.0.0.1:6379/15",
          concurrency: 1,
          batchSize: 10,
          leaseMs: 30_000,
          signalSource: doubles.signalSource,
          dependencies: doubles.dependencies,
          logger: { info() {}, error() {} },
        }),
      ).rejects.toThrow("Worker startup failed");

      expect(doubles.calls).toEqual(expectedCalls);
    },
  );

  test("startup cleanup attempts every resource when earlier cleanup rejects", async () => {
    const cleanupCalls: string[] = [];
    const doubles = runtimeDoubles({
      throwAt: "worker",
      queueDisconnect: async () => {
        cleanupCalls.push("queue");
        throw new Error("dummy-secret-queue-cleanup");
      },
      workerConnectionDisconnect: () => {
        cleanupCalls.push("worker-valkey");
        throw new Error("dummy-secret-worker-valkey-cleanup");
      },
      producerDisconnect: () => {
        cleanupCalls.push("producer-valkey");
        throw new Error("dummy-secret-producer-valkey-cleanup");
      },
      databaseClose: async () => {
        cleanupCalls.push("postgres");
        throw new Error("dummy-secret-postgres-cleanup");
      },
    });

    await expect(
      startWorker({
        databaseUrl: "postgresql://unused:unused@127.0.0.1:5432/unused",
        valkeyUrl: "redis://127.0.0.1:6379/15",
        concurrency: 1,
        batchSize: 10,
        leaseMs: 30_000,
        signalSource: doubles.signalSource,
        dependencies: doubles.dependencies,
        logger: { info() {}, error() {} },
      }),
    ).rejects.toThrow("Worker startup failed");

    expect(cleanupCalls).toEqual([
      "queue",
      "worker-valkey",
      "producer-valkey",
      "postgres",
    ]);
  });

  test.each([
    [
      "hostname",
      {
        hostname: () => {
          throw new Error("dummy-secret-hostname");
        },
      },
    ],
    [
      "random UUID",
      {
        randomUUID: () => {
          throw new Error("dummy-secret-random-uuid");
        },
      },
    ],
  ] as const)(
    "%s identity failure exposes only a fixed error without acquiring resources",
    async (_identityStage, identityOptions) => {
      const doubles = runtimeDoubles(identityOptions);

      await expect(
        startWorker({
          databaseUrl: "postgresql://unused:unused@127.0.0.1:5432/unused",
          valkeyUrl: "redis://127.0.0.1:6379/15",
          concurrency: 1,
          batchSize: 10,
          leaseMs: 30_000,
          signalSource: doubles.signalSource,
          dependencies: doubles.dependencies,
          logger: { info() {}, error() {} },
        }),
      ).rejects.toThrow("Worker startup failed");

      expect(doubles.acquisitions).toEqual([]);
      expect(doubles.calls).toEqual([]);
    },
  );

  test("throwing cleanup logger cannot stop startup unwind or replace fixed error", async () => {
    const cleanupCalls: string[] = [];
    const rejectCleanup = (resource: string) => async () => {
      cleanupCalls.push(resource);
      throw new Error(`dummy-secret-${resource}-cleanup`);
    };
    const doubles = runtimeDoubles({
      throwAt: "worker",
      queueDisconnect: rejectCleanup("queue"),
      workerConnectionDisconnect: () => {
        cleanupCalls.push("worker-valkey");
        throw new Error("dummy-secret-worker-valkey-cleanup");
      },
      producerDisconnect: () => {
        cleanupCalls.push("producer-valkey");
        throw new Error("dummy-secret-producer-valkey-cleanup");
      },
      databaseClose: rejectCleanup("postgres"),
    });

    await expect(
      startWorker({
        databaseUrl: "postgresql://unused:unused@127.0.0.1:5432/unused",
        valkeyUrl: "redis://127.0.0.1:6379/15",
        concurrency: 1,
        batchSize: 10,
        leaseMs: 30_000,
        signalSource: doubles.signalSource,
        dependencies: doubles.dependencies,
        logger: {
          info() {},
          error() {
            throw new Error("dummy-secret-logger-error");
          },
        },
      }),
    ).rejects.toThrow("Worker startup failed");

    expect(cleanupCalls).toEqual([
      "queue",
      "worker-valkey",
      "producer-valkey",
      "postgres",
    ]);
  });

  test("shutdown force-attempts every resource at the 25-second cap", async () => {
    vi.useFakeTimers();
    const doubles = runtimeDoubles({
      workerClose: () => {
        doubles.calls.push("worker-graceful");
        return new Promise(() => undefined);
      },
      queueClose: async () => {
        doubles.calls.push("queue-close-wrong");
      },
      workerDisconnect: async () => {
        doubles.calls.push("worker-force");
      },
      queueDisconnect: async () => {
        doubles.calls.push("queue-force");
      },
      databaseClose: async () => {
        doubles.calls.push("postgres-force");
      },
    });
    const handle = await startWorker({
      databaseUrl: "postgresql://unused:unused@127.0.0.1:5432/unused",
      valkeyUrl: "redis://127.0.0.1:6379/15",
      concurrency: 1,
      batchSize: 10,
      leaseMs: 30_000,
      signalSource: doubles.signalSource,
      dependencies: doubles.dependencies,
    });
    let stopped = false;
    void handle.whenStopped.then(() => {
      stopped = true;
    });

    doubles.signalSource.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(24_999);
    expect(stopped).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(stopped).toBe(true);
    expect(doubles.calls).toEqual([
      "worker-graceful",
      "worker-force",
      "queue-force",
      "producer-valkey-force",
      "worker-valkey-force",
      "postgres-force",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("shutdown attempts later resources when every earlier close rejects", async () => {
    vi.useFakeTimers();
    const closeCalls: string[] = [];
    const rejectingClose = (name: string) => async () => {
      closeCalls.push(name);
      throw new Error(`dummy-secret-${name}`);
    };
    const doubles = runtimeDoubles({
      workerClose: rejectingClose("worker"),
      queueClose: rejectingClose("queue"),
      producerQuit: rejectingClose("producer-valkey"),
      workerQuit: rejectingClose("worker-valkey"),
      databaseClose: rejectingClose("postgres"),
    });
    const handle = await startWorker({
      databaseUrl: "postgresql://unused:unused@127.0.0.1:5432/unused",
      valkeyUrl: "redis://127.0.0.1:6379/15",
      concurrency: 1,
      batchSize: 10,
      leaseMs: 30_000,
      signalSource: doubles.signalSource,
      dependencies: doubles.dependencies,
      logger: { info() {}, error() {} },
    });

    await expect(handle.stop()).resolves.toBeUndefined();
    await expect(handle.whenStopped).resolves.toBeUndefined();
    expect(closeCalls).toEqual([
      "worker",
      "queue",
      "producer-valkey",
      "worker-valkey",
      "postgres",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
