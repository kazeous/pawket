import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

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
  workerJobDurationSeconds,
  workerJobsTotal,
  type RequestContext,
} from "@pawket/observability";
import {
  createQueueConnection,
  createSystemQueue,
  dispatchOutboxBatch,
  OUTBOX_JOB,
  SYSTEM_QUEUE,
  type SystemOutboxJob,
} from "@pawket/queue";

import {
  startWorker,
  type WorkerRuntimeDependencies,
} from "../src/worker-runtime.js";

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
  queue: ReturnType<typeof createSystemQueue>,
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
  const counter = await workerJobsTotal.get();
  const duration = await workerJobDurationSeconds.get();
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
    const eventId = await db.transaction((tx) =>
      insertOutboxEvent(tx, {
        eventType: "system.foundation.ping.v1",
        eventVersion: 1,
        aggregateType: "system",
        aggregateId: randomUUID(),
        payload: {
          profile: { apiToken: "dummy-secret-token" },
          callback: "postgresql://dummy:dummy@database.invalid/pawket",
        },
        occurredAt: now,
        availableAt: now,
      }),
    );

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

});

describe("worker runtime integration", () => {
  const database = createDatabase(databaseUrl);
  const { db } = database;
  const runtimeUrl = isolatedValkeyUrl(valkeyUrl, 12);
  const inspectionConnection = createQueueConnection(runtimeUrl);
  const inspectionQueue = createSystemQueue(inspectionConnection);
  const handles: Array<{ stop(): Promise<void> }> = [];

  beforeAll(async () => {
    await waitForReady(inspectionConnection);
  });

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.stop()));
    await db.delete(systemOutbox);
    await inspectionQueue.obliterate({ force: true });
  });

  afterAll(async () => {
    await inspectionQueue.close();
    await inspectionConnection.quit();
    await database.close();
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
    const metricNames = (await workerJobsTotal.get()).values.map((value) => value.labels.name);
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
      workerQuit?: () => Promise<void>;
      databaseClose?: () => Promise<void>;
      onWorkerConnectionCreate?: () => void;
    } = {},
  ) {
    const calls: string[] = [];
    const signalSource = new EventEmitter();
    const dispatch = vi.fn(async () => ({ claimed: 0, enqueued: 0, failed: 0 }));

    return {
      calls,
      dispatch,
      signalSource,
      dependencies: {
        createDatabase: () => ({
          db: {},
          close:
            options.databaseClose ??
            (async () => {
              calls.push("postgres");
            }),
        }),
        createProducerConnection: () => ({
          connect: options.producerConnect ?? (async () => undefined),
          quit:
            options.producerQuit ??
            (async () => {
              calls.push("producer-valkey");
            }),
          disconnect: () => {
            calls.push("producer-valkey-force");
          },
        }),
        createWorkerConnection: () => {
          options.onWorkerConnectionCreate?.();
          return {
            quit:
              options.workerQuit ??
              (async () => {
                calls.push("worker-valkey");
              }),
            disconnect: () => {
              calls.push("worker-valkey-force");
            },
          };
        },
        createQueue: () => ({
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
        }),
        createWorker: () => ({
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
        }),
        dispatch,
      } as unknown as Partial<WorkerRuntimeDependencies>,
    };
  }

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
