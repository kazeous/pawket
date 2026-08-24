import { loadServerEnv } from "@pawket/config";
import {
  DeterministicLocalSecurityEmailSink,
  DisabledSecurityEmailSender,
} from "@pawket/identity/security-email";
import { createLogger } from "@pawket/observability";
import { createEncryptionKeyring } from "@pawket/security";

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
    sender:
      env.SECURITY_EMAIL_ADAPTER === "local"
        ? new DeterministicLocalSecurityEmailSink()
        : new DisabledSecurityEmailSender(),
  },
  logger,
});

logger.info({ event: "worker.started" }, "Worker started");
await worker.whenStopped;
