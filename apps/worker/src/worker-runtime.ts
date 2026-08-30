import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { types as nodeTypes } from "node:util";

import { Worker, type Job, type Processor } from "bullmq";

import {
  acknowledgeOutboxEvent,
  createDatabase,
  readOperationalBacklogMetrics,
  runRetentionSweep,
} from "@pawket/database";
import {
  deliverSecurityEmailHandoff,
} from "@pawket/identity/security-email-handoff";
import type {
  SecurityEmailPurpose,
  SecurityEmailSender,
} from "@pawket/identity/security-email";
import type { EncryptionKeyring } from "@pawket/security";
import {
  recordRefundOperation,
  recordWorkerJobMetrics,
  recordSecurityEmailMetrics,
  recordRetentionMetrics,
  setOutboxMetrics,
  setRefundLiabilityMetrics,
  setSecurityEmailBacklogMetrics,
  setWorkerLastSuccessMetric,
  setWorkerScanHealthMetric,
  withRequestContext,
} from "@pawket/observability";
import { scanVerificationDepositRefundWindows } from "@pawket/payments";
import {
  processPublicMediaAsset,
  type ObjectStoragePort,
} from "@pawket/public-media";
import {
  MEDIA_PROCESS_JOB,
  MEDIA_QUEUE,
  OUTBOX_JOB,
  SYSTEM_QUEUE,
  connectQueueProducer,
  connectQueueWorker,
  createMediaQueue,
  createQueueConnection,
  createSystemQueue,
  createWorkerConnection,
  dispatchOutboxBatch,
  enqueueMediaAsset,
  parsePublicMediaCompletedPayload,
  type MediaAssetJob,
  type MediaQueuePublisher,
  type SystemOutboxJob,
} from "@pawket/queue";

import type { WorkerHealthState } from "./worker-health.js";
import { DOMAIN_EMAIL_EVENTS, materializeDomainEmailHandoff } from "./domain-email.js";

const POLL_INTERVAL_MS = 1_000;
const SHUTDOWN_TIMEOUT_MS = 25_000;
const REFUND_SCAN_INTERVAL_MS = 60_000;
const SAFE_PAYMENTS_EVENTS = new Set([
  "payments.verification_deposit_challenge_issued.v1",
  "payments.verification_deposit_received.v1",
  "payments.receiving_account_control_verified.v1",
  "payments.verification_deposit_refund_due_soon.v1",
  "payments.verification_deposit_refund_due_today.v1",
  "payments.verification_deposit_refund_overdue.v1",
  "payments.verification_deposit_refund_sent.v1",
  "payments.verification_deposit_refund_attention_required.v1",
]);
const SAFE_DOMAIN_EVENTS = new Set([
  "identity.user_registered.v1",
  "identity.email_verified.v1",
  "identity.password_changed.v1",
  "identity.primary_email_changed.v1",
  "identity.user_access_changed.v1",
  "creator.application.submitted.v1",
  "creator.application.withdrawn.v1",
  "creator.application_changes_requested.v1",
  "creator.application_approved.v1",
  "creator.application_rejected.v1",
  "creator.application_reopened.v1",
  "creator.capability_suspended.v1",
  "creator.capability_reinstated.v1",
]);

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
type MediaQueueResource = ReturnType<typeof createMediaQueue>;
type MediaWorkerResource = Pick<Worker<MediaAssetJob>, "close" | "disconnect">;

export type WorkerRuntimeDependencies = {
  createDatabase(databaseUrl: string): DatabaseResource;
  createProducerConnection(valkeyUrl: string): ConnectionResource;
  createWorkerConnection(valkeyUrl: string): ConnectionResource;
  createQueue(connection: ConnectionResource): QueueResource;
  createMediaQueue(connection: ConnectionResource): MediaQueueResource;
  createWorker(
    processor: Processor<SystemOutboxJob>,
    connection: ConnectionResource,
    concurrency: number,
  ): WorkerResource;
  createMediaWorker(
    processor: Processor<MediaAssetJob>,
    connection: ConnectionResource,
    concurrency: number,
  ): MediaWorkerResource;
  dispatch: typeof dispatchOutboxBatch;
  acknowledge: typeof acknowledgeOutboxEvent;
  processMediaAsset: typeof processPublicMediaAsset;
  scanRefundWindows: typeof scanVerificationDepositRefundWindows;
  readBacklogMetrics: typeof readOperationalBacklogMetrics;
  runRetention: typeof runRetentionSweep;
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
  securityEmail?: {
    keyring: EncryptionKeyring;
    sender: SecurityEmailSender;
  };
  publicMedia?: {
    storage: ObjectStoragePort;
    concurrency: number;
  };
  healthState?: WorkerHealthState;
  retention?: {
    mode: "report_only" | "enforce";
    policyVersion: string;
    enforcementPaused: boolean;
    batchSize: number;
    scanIntervalMs: number;
  };
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
  createMediaQueue,
  createWorker(processor, connection, concurrency) {
    return new Worker<SystemOutboxJob>(SYSTEM_QUEUE, processor, {
      concurrency,
      connection,
    });
  },
  createMediaWorker(processor, connection, concurrency) {
    return new Worker<MediaAssetJob>(MEDIA_QUEUE, processor, {
      concurrency,
      connection,
    });
  },
  dispatch: dispatchOutboxBatch,
  acknowledge: acknowledgeOutboxEvent,
  processMediaAsset: processPublicMediaAsset,
  scanRefundWindows: scanVerificationDepositRefundWindows,
  readBacklogMetrics: readOperationalBacklogMetrics,
  runRetention: runRetentionSweep,
  hostname,
  randomUUID,
};

export function createWorkerJobProcessor(input: {
  logger: RuntimeLogger;
  database: DatabaseResource["db"];
  acknowledge: typeof acknowledgeOutboxEvent;
  mediaQueue?: MediaQueuePublisher;
  securityEmail?: {
    keyring: EncryptionKeyring;
    sender: SecurityEmailSender;
    deliver?: typeof deliverSecurityEmailHandoff;
    materialize?: typeof materializeDomainEmailHandoff;
  };
}): Processor<SystemOutboxJob> {
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
          if (job.data.eventType === "identity.security_email.requested.v1") {
            const handoffId = job.data.payload.handoffId;
            const purpose = job.data.payload.purpose;
            if (
              typeof handoffId !== "string" ||
              handoffId !== job.data.aggregateId ||
              typeof purpose !== "string" ||
              ![
                "email_verification",
                "password_reset",
                "email_change",
                "security_notice",
                "application_outcome",
                "creator_status",
                "refund_status",
              ].includes(purpose)
            ) {
              throw new Error("Invalid security email job");
            }
            if (!input.securityEmail) {
              throw new Error("Security email delivery unavailable");
            }
            let delivery:
              | "delivered"
              | "already_delivered"
              | "attention_required"
              | "already_attention_required";
            try {
              delivery = await (input.securityEmail.deliver ?? deliverSecurityEmailHandoff)(input.database, {
                handoffId,
                workerId: job.id,
                keyring: input.securityEmail.keyring,
                sender: input.securityEmail.sender,
                now: new Date(),
              });
            } catch (error) {
              recordSecurityEmailMetrics({
                purpose: purpose as SecurityEmailPurpose,
                outcome: "retryable_failure",
              });
              throw error;
            }
            if (delivery === "delivered") {
              recordSecurityEmailMetrics({
                purpose: purpose as SecurityEmailPurpose,
                outcome: "sent",
              });
            } else if (delivery === "attention_required") {
              recordSecurityEmailMetrics({
                purpose: purpose as SecurityEmailPurpose,
                outcome: "attention_required",
              });
            }
          } else if (DOMAIN_EMAIL_EVENTS.has(job.data.eventType)) {
            if (!input.securityEmail) {
              throw new Error("Security email delivery unavailable");
            }
            const materialized = await (input.securityEmail.materialize ?? materializeDomainEmailHandoff)({
              db: input.database,
              event: job.data,
              keyring: input.securityEmail.keyring,
              now: new Date(),
            });
            if (materialized !== "already_materialized") {
              const purpose = job.data.eventType.startsWith("creator.application")
                ? "application_outcome"
                : job.data.eventType.startsWith("creator.capability")
                  ? "creator_status"
                  : "refund_status";
              recordSecurityEmailMetrics({
                purpose,
                outcome: materialized === "created" ? "queued" : "attention_required",
              });
            }
          } else if (job.data.eventType === "media.public_upload_completed.v1") {
            if (!input.mediaQueue) throw new Error("Public media processing unavailable");
            const payload = parsePublicMediaCompletedPayload(job.data.payload);
            if (payload.assetId !== job.data.aggregateId) {
              throw new Error("Invalid public media completion payload");
            }
            await enqueueMediaAsset(input.mediaQueue, payload.assetId);
          } else if (
            job.data.eventType !== "system.foundation.ping.v1" &&
            !SAFE_PAYMENTS_EVENTS.has(job.data.eventType) &&
            !SAFE_DOMAIN_EVENTS.has(job.data.eventType)
          ) {
            throw new Error("Unsupported outbox event type");
          }
          const acknowledged = await input.acknowledge(input.database, {
            eventId: job.data.outboxEventId,
          });
          if (!acknowledged) {
            throw new Error("Outbox event acknowledgement failed");
          }
        } catch (error) {
          outcome = "failed";
          input.logger.error(
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
              error.message === "Invalid security email job" ||
              error.message === "Security email delivery unavailable" ||
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

function exactMediaJobData(value: unknown): { assetId: string } | null {
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value)) return null;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== 1 || ownKeys[0] !== "assetId") return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, "assetId");
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
    const assetId = descriptor.value;
    return typeof assetId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(assetId)
      ? { assetId }
      : null;
  } catch {
    return null;
  }
}

export function createMediaJobProcessor(input: {
  logger: RuntimeLogger;
  database: DatabaseResource["db"];
  storage: ObjectStoragePort;
  workerId: string;
  processAsset?: typeof processPublicMediaAsset;
}): Processor<MediaAssetJob> {
  return async (job: Job<MediaAssetJob>) => {
    const data = exactMediaJobData(job.data);
    if (
      !job.id ||
      job.name !== MEDIA_PROCESS_JOB ||
      !data ||
      job.id !== data.assetId
    ) throw new Error("Invalid public media worker job");
    return withRequestContext(
      { requestId: job.id, jobId: job.id },
      async () => {
        try {
          await (input.processAsset ?? processPublicMediaAsset)(
            input.database,
            input.storage,
            data.assetId,
            { workerId: input.workerId },
          );
        } catch {
          input.logger.error(
            { category: "public_media_worker_failed", jobId: job.id },
            "Public media worker job failed",
          );
          throw new Error("Public media worker processing failed");
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
  let mediaQueue: MediaQueueResource | undefined;
  let mediaWorker: MediaWorkerResource | undefined;

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

    if (mediaWorker) {
      await attemptCleanup("media-worker", () => mediaWorker?.disconnect());
    }
    if (worker) {
      await attemptCleanup("worker", () => worker?.disconnect());
    }
    if (mediaQueue) {
      await attemptCleanup("media-queue", () => mediaQueue?.disconnect());
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
    if (options.publicMedia) {
      mediaQueue = dependencies.createMediaQueue(producerConnection);
    }
    worker = dependencies.createWorker(
      createWorkerJobProcessor({
        logger,
        database: database.db,
        acknowledge: dependencies.acknowledge,
        mediaQueue,
        securityEmail: options.securityEmail,
      }),
      workerConnection,
      options.concurrency,
    );
    if (options.publicMedia) {
      mediaWorker = dependencies.createMediaWorker(
        createMediaJobProcessor({
          logger,
          database: database.db,
          storage: options.publicMedia.storage,
          workerId,
          processAsset: dependencies.processMediaAsset,
        }),
        workerConnection,
        options.publicMedia.concurrency,
      );
    }
    if (options.healthState) {
      options.healthState.initializedAt = Date.now();
      options.healthState.stopping = false;
    }
  } catch {
    await startupCleanup();
    throw new Error("Worker startup failed");
  }

  let running = true;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let currentDispatch: Promise<void> | undefined;
  let lastRefundScanAt = 0;
  let lastRetentionScanAt = 0;
  let stopPromise: Promise<void> | undefined;
  let resolveStopped!: () => void;
  const whenStopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  setWorkerScanHealthMetric({ scan: "outbox", healthy: false });
  setWorkerScanHealthMetric({ scan: "refund", healthy: false });
  if (options.retention) {
    setWorkerScanHealthMetric({ scan: "retention", healthy: false });
  }

  const scanRetentionIfDue = async (scanAt: number): Promise<void> => {
    if (
      !options.retention ||
      scanAt - lastRetentionScanAt < options.retention.scanIntervalMs
    ) {
      return;
    }
    lastRetentionScanAt = scanAt;
    setWorkerScanHealthMetric({ scan: "retention", healthy: false });
    try {
      const retention = await dependencies.runRetention({
        db: database.db,
        now: new Date(scanAt),
        mode: options.retention.mode,
        policyVersion: options.retention.policyVersion,
        enforcementPaused: options.retention.enforcementPaused,
        batchSize: options.retention.batchSize,
      });
      for (const result of retention) {
        recordRetentionMetrics({
          dataset: result.dataset,
          mode: options.retention.mode,
          disposition: result.outcome === "failed" ? "failed" : "candidate",
          count: result.outcome === "failed" ? 1 : result.candidateCount,
        });
        recordRetentionMetrics({
          dataset: result.dataset,
          mode: options.retention.mode,
          disposition: "protected",
          count: result.protectedCount,
        });
        recordRetentionMetrics({
          dataset: result.dataset,
          mode: options.retention.mode,
          disposition: "processed",
          count: result.processedCount,
        });
      }
      if (retention.some((result) => result.outcome === "failed")) {
        setWorkerScanHealthMetric({ scan: "retention", healthy: false });
        logger.error(
          { category: "retention_scan_failed", workerId, mode: options.retention.mode },
          "Retention scan failed",
        );
      } else {
        setWorkerLastSuccessMetric({
          scan: "retention",
          timestampSeconds: scanAt / 1_000,
        });
        setWorkerScanHealthMetric({ scan: "retention", healthy: true });
        logger.info(
          {
            workerId,
            mode: options.retention.mode,
            paused: options.retention.enforcementPaused,
            candidateCount: retention.reduce((sum, result) => sum + result.candidateCount, 0),
            protectedCount: retention.reduce((sum, result) => sum + result.protectedCount, 0),
            processedCount: retention.reduce((sum, result) => sum + result.processedCount, 0),
          },
          "Retention scan completed",
        );
      }
    } catch {
      setWorkerScanHealthMetric({ scan: "retention", healthy: false });
      logger.error(
        { category: "retention_scan_failed", workerId, mode: options.retention.mode },
        "Retention scan failed",
      );
    }
  };

  const poll = async (): Promise<void> => {
    if (!running) {
      return;
    }

    try {
      const scanAt = Date.now();
      if (scanAt - lastRefundScanAt >= REFUND_SCAN_INTERVAL_MS) {
        lastRefundScanAt = scanAt;
        setWorkerScanHealthMetric({ scan: "refund", healthy: false });
        try {
          const liabilities = await dependencies.scanRefundWindows({
            db: database.db,
            now: new Date(scanAt),
          });
          setRefundLiabilityMetrics(liabilities);
          setWorkerLastSuccessMetric({ scan: "refund", timestampSeconds: scanAt / 1_000 });
          setWorkerScanHealthMetric({ scan: "refund", healthy: true });
          recordRefundOperation({ operation: "window", outcome: "succeeded" });
          if (options.healthState) options.healthState.lastRefundScanSucceededAt = scanAt;
          if (liabilities.dueSoon + liabilities.dueToday + liabilities.overdue > 0) {
            logger.info(
              {
                workerId,
                dueSoon: liabilities.dueSoon,
                dueToday: liabilities.dueToday,
                overdue: liabilities.overdue,
                outstandingAmountVnd: liabilities.outstandingAmountVnd,
              },
              "Refund liabilities scanned",
            );
          }
        } catch {
          setWorkerScanHealthMetric({ scan: "refund", healthy: false });
          recordRefundOperation({ operation: "window", outcome: "retryable_failure" });
          logger.error(
            { category: "refund_liability_scan_failed", workerId },
            "Refund liability scan failed",
          );
        }
      }
      setWorkerScanHealthMetric({ scan: "outbox", healthy: false });
      const result = await dependencies.dispatch(
        { db: database.db, queue },
        {
          workerId,
          batchSize: options.batchSize,
          leaseMs: options.leaseMs,
        },
      );
      const pollSucceededAt = Date.now();
      const backlog = await dependencies.readBacklogMetrics(database.db, new Date(pollSucceededAt));
      setOutboxMetrics(backlog.outbox);
      setSecurityEmailBacklogMetrics(backlog.email);
      if (result.failed > 0) {
        setWorkerScanHealthMetric({ scan: "outbox", healthy: false });
        logger.error(
          { category: "outbox_dispatch_incomplete", workerId, ...result },
          "Outbox dispatch completed with enqueue failures",
        );
      } else {
        setWorkerLastSuccessMetric({ scan: "outbox", timestampSeconds: pollSucceededAt / 1_000 });
        setWorkerScanHealthMetric({ scan: "outbox", healthy: true });
        if (options.healthState) options.healthState.lastPollSucceededAt = pollSucceededAt;
      }
      if (result.claimed > 0 && result.failed === 0) {
        logger.info({ workerId, ...result }, "Outbox batch dispatched");
      }
    } catch {
      setWorkerScanHealthMetric({ scan: "outbox", healthy: false });
      logger.error(
        { category: "outbox_poll_failed", workerId },
        "Outbox polling failed",
      );
    } finally {
      await scanRetentionIfDue(Date.now());
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
    if (options.healthState) options.healthState.stopping = true;
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
      if (mediaWorker) await attemptClose("media-worker", () => mediaWorker.close());
      await attemptClose("worker", () => worker.close());
      if (mediaQueue) await attemptClose("media-queue", () => mediaQueue.close());
      await attemptClose("queue", () => queue.close());
      await attemptClose("producer-valkey", () => producerConnection.quit());
      await attemptClose("worker-valkey", () => workerConnection.quit());
      await attemptClose("postgres", () => database.close());
    };
    const forceClose = (): void => {
      if (mediaWorker) void attemptClose("media-worker-force", () => mediaWorker.disconnect());
      void attemptClose("worker-force", () => worker.disconnect());
      if (mediaQueue) void attemptClose("media-queue-force", () => mediaQueue.disconnect());
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
