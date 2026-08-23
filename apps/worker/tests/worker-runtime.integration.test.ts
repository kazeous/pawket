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

async function workerMetricSnapshot(outcome: "completed" | "failed") {
  const counter = await workerJobsTotal.get();
  const duration = await workerJobDurationSeconds.get();
  const labels = { queue: SYSTEM_QUEUE, name: OUTBOX_JOB, outcome };
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

  test("does not mark a claimed row published until queue add succeeds", async () => {
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
    expect(afterAddCompletes?.publishedAt).not.toBeNull();
  });

  test("queue failure releases the lease and schedules the event for retry", async () => {
    const now = new Date();
    await insertFoundationEvent(now);
    const unavailableQueue = {
      add: vi.fn(async () => {
        throw new Error("queue unavailable");
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
        lastError: "queue unavailable",
        availableAt: new Date(now.getTime() + 1_000),
      }),
    );
  });

  test("retry after enqueue success and acknowledgement failure deduplicates by outbox ID", async () => {
    const firstAttemptAt = new Date();
    const eventId = await insertFoundationEvent(firstAttemptAt);
    const acknowledgementFailure = vi.fn(async () => {
      throw new Error("database acknowledgement unavailable");
    });

    await expect(
      dispatchOutboxBatch(
        { db, queue, markPublished: acknowledgementFailure },
        {
          workerId: "dispatcher-crash-window",
          batchSize: 10,
          leaseMs: 30_000,
          now: () => firstAttemptAt,
        },
      ),
    ).resolves.toEqual({ claimed: 1, enqueued: 1, failed: 1 });

    await expect(
      dispatchOutboxBatch(
        { db, queue },
        {
          workerId: "dispatcher-retry",
          batchSize: 10,
          leaseMs: 30_000,
          now: () => new Date(firstAttemptAt.getTime() + 1_000),
        },
      ),
    ).resolves.toEqual({ claimed: 1, enqueued: 1, failed: 0 });

    expect(await queue.getJobs(["wait", "active", "delayed", "completed", "failed"])).toHaveLength(
      1,
    );
    expect((await queue.getJob(eventId))?.data.outboxEventId).toBe(eventId);
    const [published] = await db.select().from(systemOutbox);
    expect(published?.publishedAt).not.toBeNull();
  });
});

describe("worker runtime integration", () => {
  const database = createDatabase(databaseUrl);
  const { db } = database;
  const runtimeUrl = isolatedValkeyUrl(valkeyUrl, 12);
  const inspectionConnection = createQueueConnection(runtimeUrl);
  const inspectionQueue = createSystemQueue(inspectionConnection);
  const handles: Array<{ stop(): Promise<void> }> = [];

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

  test("an unknown event type fails visibly and remains retained", async () => {
    const metricsBefore = await workerMetricSnapshot("failed");
    const observedContexts: Array<RequestContext | undefined> = [];
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
        error() {
          observedContexts.push(getRequestContext());
        },
      },
    });
    handles.push(handle);
    const outboxEventId = randomUUID();
    const payload: SystemOutboxJob = {
      outboxEventId,
      eventType: "system.unknown.v1",
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
    expect(observedContexts).toContainEqual({
      requestId: outboxEventId,
      outboxEventId,
      jobId: outboxEventId,
    });
    const metricsAfter = await workerMetricSnapshot("failed");
    expect(metricsAfter.jobs - metricsBefore.jobs).toBe(1);
    expect(metricsAfter.durations - metricsBefore.durations).toBe(1);
  });
});

describe("worker shutdown", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function runtimeDoubles(options: { workerClose?: () => Promise<void> } = {}) {
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
          close: async () => {
            calls.push("postgres");
          },
        }),
        createConnection: () => ({
          quit: async () => {
            calls.push("valkey");
          },
          disconnect: () => {
            calls.push("valkey-force");
          },
        }),
        createQueue: () => ({
          close: async () => {
            calls.push("queue");
          },
        }),
        createWorker: () => ({
          close:
            options.workerClose ??
            (async () => {
              calls.push("worker");
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
    expect(doubles.calls).toEqual(["worker", "queue", "valkey", "postgres"]);
  });

  test("shutdown resolves at the 25-second cap when graceful close hangs", async () => {
    vi.useFakeTimers();
    const doubles = runtimeDoubles({ workerClose: () => new Promise(() => undefined) });
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
    expect(doubles.calls).toContain("valkey-force");
  });
});
