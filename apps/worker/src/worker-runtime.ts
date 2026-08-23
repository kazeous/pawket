import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { Worker, type Job, type Processor } from "bullmq";

import { acknowledgeOutboxEvent, createDatabase } from "@pawket/database";
import {
  recordWorkerJobMetrics,
  withRequestContext,
} from "@pawket/observability";
import {
  OUTBOX_JOB,
  SYSTEM_QUEUE,
  connectQueueProducer,
  connectQueueWorker,
  createQueueConnection,
  createSystemQueue,
  createWorkerConnection,
  dispatchOutboxBatch,
  type SystemOutboxJob,
} from "@pawket/queue";

const POLL_INTERVAL_MS = 1_000;
const SHUTDOWN_TIMEOUT_MS = 25_000;

type RuntimeLogger = {
  info(data: Record<string, unknown>, message?: string): void;
  error(data: Record<string, unknown>, message?: string): void;
};

type SignalSource = {
  on(event: "SIGTERM", listener: () => void): unknown;
  off(event: "SIGTERM", listener: () => void): unknown;
};

type DatabaseResource = ReturnType<typeof createDatabase>;
type ConnectionResource = ReturnType<typeof createQueueConnection>;
type QueueResource = ReturnType<typeof createSystemQueue>;
type WorkerResource = Pick<Worker<SystemOutboxJob>, "close" | "disconnect">;

export type WorkerRuntimeDependencies = {
  createDatabase(databaseUrl: string): DatabaseResource;
  createProducerConnection(valkeyUrl: string): ConnectionResource;
  createWorkerConnection(valkeyUrl: string): ConnectionResource;
  createQueue(connection: ConnectionResource): QueueResource;
  createWorker(
    processor: Processor<SystemOutboxJob>,
    connection: ConnectionResource,
    concurrency: number,
  ): WorkerResource;
  dispatch: typeof dispatchOutboxBatch;
  acknowledge: typeof acknowledgeOutboxEvent;
  hostname(): string;
  randomUUID(): string;
};

export type StartWorkerOptions = {
  databaseUrl: string;
  valkeyUrl: string;
  concurrency: number;
  batchSize: number;
  leaseMs: number;
  logger?: RuntimeLogger;
  signalSource?: SignalSource;
  shutdownTimeoutMs?: number;
  producerOperationTimeoutMs?: number;
  dependencies?: Partial<WorkerRuntimeDependencies>;
};

export type WorkerHandle = {
  stop(): Promise<void>;
  whenStopped: Promise<void>;
};

const defaultLogger: RuntimeLogger = {
  info(data, message) {
    console.info(JSON.stringify({ ...data, message }));
  },
  error(data, message) {
    console.error(JSON.stringify({ ...data, message }));
  },
};

const defaultDependencies: WorkerRuntimeDependencies = {
  createDatabase,
  createProducerConnection: createQueueConnection,
  createWorkerConnection,
  createQueue: createSystemQueue,
  createWorker(processor, connection, concurrency) {
    return new Worker<SystemOutboxJob>(SYSTEM_QUEUE, processor, {
      concurrency,
      connection,
    });
  },
  dispatch: dispatchOutboxBatch,
  acknowledge: acknowledgeOutboxEvent,
  hostname,
  randomUUID,
};

function createProcessor(
  logger: RuntimeLogger,
  database: DatabaseResource["db"],
  acknowledge: typeof acknowledgeOutboxEvent,
): Processor<SystemOutboxJob> {
  return async (job: Job<SystemOutboxJob>) => {
    if (!job.id) {
      throw new Error("BullMQ job ID is required");
    }

    return withRequestContext(
      {
        requestId: job.id,
        outboxEventId: job.data.outboxEventId,
        jobId: job.id,
      },
      async () => {
        const startedAt = performance.now();
        let outcome: "completed" | "failed" = "completed";
        const metricJobName = job.name === OUTBOX_JOB ? OUTBOX_JOB : "unsupported";

        try {
          if (job.name !== OUTBOX_JOB) {
            throw new Error("Unsupported system job name");
          }
          if (job.id !== job.data.outboxEventId) {
            throw new Error("Outbox job ID does not match outbox event ID");
          }
          if (job.data.eventType !== "system.foundation.ping.v1") {
            throw new Error("Unsupported outbox event type");
          }
          const acknowledged = await acknowledge(database, {
            eventId: job.data.outboxEventId,
          });
          if (!acknowledged) {
            throw new Error("Outbox event acknowledgement failed");
          }
        } catch (error) {
          outcome = "failed";
          logger.error(
            {
              category: "worker_job_failed",
              outboxEventId: job.data.outboxEventId,
              jobId: job.id,
            },
            "Worker job failed",
          );
          if (
            error instanceof Error &&
            (error.message === "Unsupported system job name" ||
              error.message === "Outbox job ID does not match outbox event ID" ||
              error.message === "Unsupported outbox event type" ||
              error.message === "Outbox event acknowledgement failed")
          ) {
            throw error;
          }
          throw new Error("Worker job processing failed");
        } finally {
          recordWorkerJobMetrics({
            name: metricJobName,
            outcome,
            durationSeconds: (performance.now() - startedAt) / 1_000,
          });
        }
      },
    );
  };
}

export async function startWorker(options: StartWorkerOptions): Promise<WorkerHandle> {
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  const logger = options.logger ?? defaultLogger;
  const signalSource = options.signalSource ?? process;
  let workerId: string;
  try {
    workerId = `${dependencies.hostname()}:${dependencies.randomUUID()}`;
  } catch {
    throw new Error("Worker startup failed");
  }
  let database: DatabaseResource | undefined;
  let producerConnection: ConnectionResource | undefined;
  let workerConnection: ConnectionResource | undefined;
  let queue: QueueResource | undefined;
  let worker: WorkerResource | undefined;

  const startupCleanup = async (): Promise<void> => {
    const attemptCleanup = async (
      resource: string,
      operation: () => Promise<unknown> | unknown,
    ): Promise<void> => {
      try {
        await operation();
      } catch {
        try {
          logger.error(
            { category: "worker_startup_cleanup_failed", resource },
            "Worker startup cleanup failed",
          );
        } catch {
          // Cleanup and the fixed startup error must survive logger failures.
        }
      }
    };

    if (worker) {
      await attemptCleanup("worker", () => worker?.disconnect());
    }
    if (queue) {
      await attemptCleanup("queue", () => queue?.disconnect());
    }
    if (workerConnection) {
      await attemptCleanup("worker-valkey", () => workerConnection?.disconnect());
    }
    if (producerConnection) {
      await attemptCleanup("producer-valkey", () => producerConnection?.disconnect());
    }
    if (database) {
      await attemptCleanup("postgres", () => database?.close());
    }
  };

  try {
    database = dependencies.createDatabase(options.databaseUrl);
    producerConnection = dependencies.createProducerConnection(options.valkeyUrl);
    await connectQueueProducer(producerConnection, options.producerOperationTimeoutMs);
    workerConnection = dependencies.createWorkerConnection(options.valkeyUrl);
    await connectQueueWorker(workerConnection, options.producerOperationTimeoutMs);
    queue = dependencies.createQueue(producerConnection);
    worker = dependencies.createWorker(
      createProcessor(logger, database.db, dependencies.acknowledge),
      workerConnection,
      options.concurrency,
    );
  } catch {
    await startupCleanup();
    throw new Error("Worker startup failed");
  }

  let running = true;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let currentDispatch: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let resolveStopped!: () => void;
  const whenStopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  const poll = async (): Promise<void> => {
    if (!running) {
      return;
    }

    try {
      const result = await dependencies.dispatch(
        { db: database.db, queue },
        {
          workerId,
          batchSize: options.batchSize,
          leaseMs: options.leaseMs,
        },
      );
      if (result.claimed > 0) {
        logger.info({ workerId, ...result }, "Outbox batch dispatched");
      }
    } catch {
      logger.error(
        { category: "outbox_poll_failed", workerId },
        "Outbox polling failed",
      );
    } finally {
      currentDispatch = undefined;
      if (running) {
        pollTimer = setTimeout(runPoll, POLL_INTERVAL_MS);
      }
    }
  };

  const runPoll = (): void => {
    currentDispatch = poll();
  };

  const shutdown = async (): Promise<void> => {
    running = false;
    if (pollTimer !== undefined) {
      clearTimeout(pollTimer);
      pollTimer = undefined;
    }

    const attemptClose = async (
      resource: string,
      operation: () => Promise<unknown>,
    ): Promise<void> => {
      try {
        await operation();
      } catch {
        logger.error(
          { category: "worker_shutdown_close_failed", resource },
          "Worker resource close failed",
        );
      }
    };
    const gracefulClose = async (): Promise<void> => {
      await currentDispatch;
      await attemptClose("worker", () => worker.close());
      await attemptClose("queue", () => queue.close());
      await attemptClose("producer-valkey", () => producerConnection.quit());
      await attemptClose("worker-valkey", () => workerConnection.quit());
      await attemptClose("postgres", () => database.close());
    };
    const forceClose = (): void => {
      void attemptClose("worker-force", () => worker.disconnect());
      void attemptClose("queue-force", () => queue.disconnect());
      try {
        producerConnection.disconnect();
      } catch {
        logger.error(
          { category: "worker_shutdown_force_disconnect_failed", resource: "producer-valkey" },
          "Worker resource force disconnect failed",
        );
      }
      try {
        workerConnection.disconnect();
      } catch {
        logger.error(
          { category: "worker_shutdown_force_disconnect_failed", resource: "worker-valkey" },
          "Worker resource force disconnect failed",
        );
      }
      void attemptClose("postgres-force", () => database.close());
    };
    const timeoutMarker = Symbol("shutdown-timeout");
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof timeoutMarker>((resolve) => {
      timeoutTimer = setTimeout(
        () => resolve(timeoutMarker),
        options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS,
      );
    });
    try {
      const outcome = await Promise.race([gracefulClose(), timeout]);

      if (outcome === timeoutMarker) {
        logger.error(
          { category: "worker_shutdown_timeout", timeoutMs: options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS },
          "Worker shutdown exceeded its deadline",
        );
        forceClose();
      }
    } finally {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
      }
    }
  };

  const stop = (): Promise<void> => {
    if (!stopPromise) {
      stopPromise = shutdown().finally(() => {
        signalSource.off("SIGTERM", onSigterm);
        resolveStopped();
      });
    }
    return stopPromise;
  };
  const onSigterm = (): void => {
    void stop();
  };

  signalSource.on("SIGTERM", onSigterm);
  runPoll();

  return { stop, whenStopped };
}
