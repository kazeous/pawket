import { loadServerEnv } from "@pawket/config";
import { createLogger } from "@pawket/observability";

import { startWorker } from "./worker-runtime.js";

const env = loadServerEnv();
const logger = createLogger({ service: "worker", env });
const worker = await startWorker({
  databaseUrl: env.DATABASE_URL,
  valkeyUrl: env.VALKEY_URL,
  concurrency: env.WORKER_CONCURRENCY,
  batchSize: env.OUTBOX_BATCH_SIZE,
  leaseMs: env.OUTBOX_LEASE_MS,
  logger,
});

logger.info({ event: "worker.started" }, "Worker started");
await worker.whenStopped;
