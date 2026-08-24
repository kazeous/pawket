import { loadServerEnv } from "@pawket/config";
import { createLogger } from "@pawket/observability";
import { createEncryptionKeyring } from "@pawket/security";
import nodemailer from "nodemailer";

import { createSecurityEmailSenderFromEnv } from "./security-email.js";
import { startWorker } from "./worker-runtime.js";

const env = loadServerEnv();
const logger = createLogger({ service: "worker", env });
const keyring = createEncryptionKeyring({
  activeKeyId: env.PII_ACTIVE_KEY_ID,
  keys: Object.fromEntries(
    Object.entries(env.PII_KEYRING_JSON).map(([keyId, key]) => [keyId, Buffer.from(key, "base64")]),
  ),
});
const worker = await startWorker({
  databaseUrl: env.DATABASE_URL,
  valkeyUrl: env.VALKEY_URL,
  concurrency: env.WORKER_CONCURRENCY,
  batchSize: env.OUTBOX_BATCH_SIZE,
  leaseMs: env.OUTBOX_LEASE_MS,
  securityEmail: {
    keyring,
    sender: createSecurityEmailSenderFromEnv({
      env,
      createTransport: (options) => nodemailer.createTransport(options),
    }),
  },
  logger,
});

logger.info({ event: "worker.started" }, "Worker started");
await worker.whenStopped;
