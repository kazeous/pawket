import type { ServerEnv } from "@pawket/config";
import { createClamdClient, createS3CommissionFileStorage, noCommissionFileEvidenceHolds } from "@pawket/commission-files";
import { readCommissionFileRetentionFacts } from "@pawket/orders";

import type { CommissionFilesWorkerConfiguration } from "./worker-runtime.js";

type Env = Pick<ServerEnv, "COMMISSION_FILES_MODE" | "COMMISSION_FILE_RETENTION_MODE" | "COMMISSION_FILES_S3_ENDPOINT" | "COMMISSION_FILES_S3_REGION" |
  "COMMISSION_FILES_S3_ACCESS_KEY_ID" | "COMMISSION_FILES_S3_SECRET_ACCESS_KEY" | "COMMISSION_FILES_QUARANTINE_BUCKET" | "COMMISSION_FILES_CLEAN_BUCKET" |
  "COMMISSION_FILES_S3_FORCE_PATH_STYLE" | "COMMISSION_FILES_CLAMD_HOST" | "COMMISSION_FILES_CLAMD_PORT" | "COMMISSION_FILES_SCAN_CONCURRENCY" |
  "COMMISSION_FILES_SCAN_TIMEOUT_MS" | "COMMISSION_FILES_MAINTENANCE_INTERVAL_MS" | "COMMISSION_FILES_MAINTENANCE_BATCH_SIZE">;

/** Scans and maintenance keep running while uploads are switched off, so nothing is left half-processed. */
export function createWorkerCommissionFilesConfiguration(env: Env): CommissionFilesWorkerConfiguration | undefined {
  const storage = env.COMMISSION_FILES_S3_ENDPOINT && env.COMMISSION_FILES_S3_REGION && env.COMMISSION_FILES_S3_ACCESS_KEY_ID && env.COMMISSION_FILES_S3_SECRET_ACCESS_KEY &&
    env.COMMISSION_FILES_QUARANTINE_BUCKET && env.COMMISSION_FILES_CLEAN_BUCKET ? {
      endpoint: env.COMMISSION_FILES_S3_ENDPOINT, region: env.COMMISSION_FILES_S3_REGION, accessKeyId: env.COMMISSION_FILES_S3_ACCESS_KEY_ID,
      secretAccessKey: env.COMMISSION_FILES_S3_SECRET_ACCESS_KEY, quarantineBucket: env.COMMISSION_FILES_QUARANTINE_BUCKET, cleanBucket: env.COMMISSION_FILES_CLEAN_BUCKET,
      forcePathStyle: env.COMMISSION_FILES_S3_FORCE_PATH_STYLE } : null;
  if (!storage || !env.COMMISSION_FILES_CLAMD_HOST) {
    if (env.COMMISSION_FILES_MODE === "enabled") throw new Error("Commission files require worker S3 storage and a clamd host");
    return undefined;
  }
  return {
    storage: createS3CommissionFileStorage(storage),
    scanner: createClamdClient({ host: env.COMMISSION_FILES_CLAMD_HOST, port: env.COMMISSION_FILES_CLAMD_PORT, timeoutMs: env.COMMISSION_FILES_SCAN_TIMEOUT_MS }),
    scannerProbe: createClamdClient({ host: env.COMMISSION_FILES_CLAMD_HOST, port: env.COMMISSION_FILES_CLAMD_PORT, timeoutMs: 5_000 }),
    concurrency: env.COMMISSION_FILES_SCAN_CONCURRENCY, batchSize: env.COMMISSION_FILES_MAINTENANCE_BATCH_SIZE,
    scanIntervalMs: env.COMMISSION_FILES_MAINTENANCE_INTERVAL_MS, retentionMode: env.COMMISSION_FILE_RETENTION_MODE,
    orders: { retentionFacts: readCommissionFileRetentionFacts }, holds: noCommissionFileEvidenceHolds,
  };
}
