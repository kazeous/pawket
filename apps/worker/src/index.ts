import { loadServerEnv, resolveRevisionAttestation } from "@pawket/config";
import {
  createLogger,
  metricsRegistry,
  setRevisionAttestationMetric,
} from "@pawket/observability";
import { createEncryptionKeyring } from "@pawket/security";
import { createS3ObjectStorage } from "@pawket/public-media";
import nodemailer from "nodemailer";

import { createSecurityEmailSenderFromEnv } from "./security-email.js";
import { createWorkerPublicMediaConfiguration } from "./public-media-cleanup-config.js";
import { startWorkerTelemetryServer } from "./telemetry-server.js";
import { createWorkerHealthState } from "./worker-health.js";
import { startWorker } from "./worker-runtime.js";

const env = loadServerEnv();
const logger = createLogger({ service: "worker", env });
const healthState = createWorkerHealthState();
const revision = resolveRevisionAttestation(env.APP_REVISION, env.APP_BUILD_REVISION);
setRevisionAttestationMetric({ service: "worker", revisionMatch: revision.revisionMatch });
const keyring = createEncryptionKeyring({
  activeKeyId: env.PII_ACTIVE_KEY_ID,
  keys: Object.fromEntries(
    Object.entries(env.PII_KEYRING_JSON).map(([keyId, key]) => [keyId, Buffer.from(key, "base64")]),
  ),
});
const publicMediaStorage = env.PUBLIC_MEDIA_S3_ENDPOINT &&
  env.PUBLIC_MEDIA_S3_REGION &&
  env.PUBLIC_MEDIA_S3_ACCESS_KEY_ID &&
  env.PUBLIC_MEDIA_S3_SECRET_ACCESS_KEY &&
  env.PUBLIC_MEDIA_QUARANTINE_BUCKET &&
  env.PUBLIC_MEDIA_DERIVATIVE_BUCKET
  ? createS3ObjectStorage({
      endpoint: env.PUBLIC_MEDIA_S3_ENDPOINT,
      region: env.PUBLIC_MEDIA_S3_REGION,
      accessKeyId: env.PUBLIC_MEDIA_S3_ACCESS_KEY_ID,
      secretAccessKey: env.PUBLIC_MEDIA_S3_SECRET_ACCESS_KEY,
      quarantineBucket: env.PUBLIC_MEDIA_QUARANTINE_BUCKET,
      derivativeBucket: env.PUBLIC_MEDIA_DERIVATIVE_BUCKET,
      forcePathStyle: env.PUBLIC_MEDIA_S3_FORCE_PATH_STYLE,
    })
  : undefined;
const publicMediaConfiguration = createWorkerPublicMediaConfiguration(env, publicMediaStorage);
const worker = await startWorker({
  databaseUrl: env.DATABASE_URL,
  valkeyUrl: env.VALKEY_URL,
  concurrency: env.WORKER_CONCURRENCY,
  batchSize: env.OUTBOX_BATCH_SIZE,
  leaseMs: env.OUTBOX_LEASE_MS,
  ...publicMediaConfiguration,
  securityEmail: {
    keyring,
    sender: createSecurityEmailSenderFromEnv({
      env,
      createTransport: (options) => nodemailer.createTransport(options),
    }),
  },
  logger,
  healthState,
  retention: {
    mode: env.RETENTION_MODE,
    policyVersion: env.RETENTION_POLICY_VERSION ?? "task8-proposed-v1",
    enforcementPaused: env.RETENTION_ENFORCEMENT_PAUSED,
    batchSize: env.RETENTION_BATCH_SIZE,
    scanIntervalMs: env.RETENTION_SCAN_INTERVAL_MS,
  },
});

let telemetry;
try {
  telemetry = await startWorkerTelemetryServer({
    port: env.WORKER_TELEMETRY_PORT,
    token: env.METRICS_TOKEN,
    registry: metricsRegistry,
    revision,
    state: healthState,
  });
} catch {
  await worker.stop();
  throw new Error("Worker telemetry startup failed");
}

logger.info(
  { event: "worker.started", telemetryPort: telemetry.port },
  "Worker started",
);
try {
  await worker.whenStopped;
} finally {
  await telemetry.stop();
}
