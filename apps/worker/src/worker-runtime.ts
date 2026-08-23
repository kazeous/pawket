import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { Worker, type Job, type Processor } from "bullmq";

import { createDatabase } from "@pawket/database";
import {
  workerJobDurationSeconds,
  workerJobsTotal,
  withRequestContext,
} from "@pawket/observability";
import {
  OUTBOX_JOB,
  SYSTEM_QUEUE,
  createQueueConnection,
  createSystemQueue,
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
type WorkerResource = Pick<Worker<SystemOutboxJob>, "close">;

export type WorkerRuntimeDependencies = {
  createDatabase(databaseUrl: string): DatabaseResource;
  createConnection(valkeyUrl: string): ConnectionResource;
  createQueue(connection: ConnectionResource): QueueResource;
  createWorker(
    processor: Processor<SystemOutboxJob>,
    connection: ConnectionResource,
    concurrency: number,
  ): WorkerResource;
  dispatch: typeof dispatchOutboxBatch;
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
  createConnection: createQueueConnection,
  createQueue: createSystemQueue,
  createWorker(processor, connection, concurrency) {
    return new Worker<SystemOutboxJob>(SYSTEM_QUEUE, processor, {
      concurrency,
      connection,
    });
  },
  dispatch: dispatchOutboxBatch,
  hostname,
  randomUUID,
};

function createProcessor(logger: RuntimeLogger): Processor<SystemOutboxJob> {
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
        let outcome = "completed";

        try {
          if (job.name !== OUTBOX_JOB) {
            throw new Error(`Unsupported system job name: ${job.name}`);
          }
          if (job.data.eventType !== "system.foundation.ping.v1") {
            throw new Error(`Unsupported outbox event type: ${job.data.eventType}`);
          }
        } catch (error) {
          outcome = "failed";
          logger.error(
            {
              error: error instanceof Error ? error.message : "Unknown worker failure",
              eventType: job.data.eventType,
              outboxEventId: job.data.outboxEventId,
              jobId: job.id,
            },
            "Worker job failed",
          );
          throw error;
        } finally {
          workerJobsTotal.inc({ queue: SYSTEM_QUEUE, name: job.name, outcome });
          workerJobDurationSeconds.observe(
            { queue: SYSTEM_QUEUE, name: job.name, outcome },
            (performance.now() - startedAt) / 1_000,
          );
        }
      },
    );
  };
}

export async function startWorker(options: StartWorkerOptions): Promise<WorkerHandle> {
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  const logger = options.logger ?? defaultLogger;
  const signalSource = options.signalSource ?? process;
  const database = dependencies.createDatabase(options.databaseUrl);
  const connection = dependencies.createConnection(options.valkeyUrl);
  const queue = dependencies.createQueue(connection);
  const worker = dependencies.createWorker(
    createProcessor(logger),
    connection,
    options.concurrency,
  );
  const workerId = `${dependencies.hostname()}:${dependencies.randomUUID()}`;
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
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : "Unknown dispatcher failure", workerId },
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
    }

    const gracefulClose = async (): Promise<void> => {
      await currentDispatch;
      await worker.close();
      await queue.close();
      await connection.quit();
      await database.close();
    };
    const timeoutMarker = Symbol("shutdown-timeout");
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof timeoutMarker>((resolve) => {
      timeoutTimer = setTimeout(
        () => resolve(timeoutMarker),
        options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS,
      );
    });
    const outcome = await Promise.race([gracefulClose(), timeout]);

    if (outcome === timeoutMarker) {
      logger.error(
        { timeoutMs: options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS },
        "Worker shutdown exceeded its deadline",
      );
      connection.disconnect();
      void database.close().catch(() => undefined);
    } else if (timeoutTimer !== undefined) {
      clearTimeout(timeoutTimer);
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
