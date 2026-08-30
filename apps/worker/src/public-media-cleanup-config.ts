import type { ObjectStoragePort } from "@pawket/public-media";

type PublicMediaWorkerEnv = Readonly<{
  PUBLIC_MEDIA_PROCESSING_CONCURRENCY: number;
  PUBLIC_MEDIA_CLEANUP_SCAN_INTERVAL_MS: number;
  PUBLIC_MEDIA_RETENTION_MODE: "report_only" | "enforce";
  RETENTION_MODE: "report_only" | "enforce";
  RETENTION_ENFORCEMENT_PAUSED: boolean;
  RETENTION_BATCH_SIZE: number;
}>;

export function createWorkerPublicMediaConfiguration(
  env: PublicMediaWorkerEnv,
  storage?: ObjectStoragePort,
) {
  if (env.PUBLIC_MEDIA_RETENTION_MODE !== "report_only") {
    throw new Error("PUBLIC_MEDIA_CLEANUP_ENFORCEMENT_NOT_CONFIGURED");
  }
  const publicMediaCleanup = {
    ...(storage === undefined ? {} : { storage }),
    mode: "report_only" as const,
    retentionMode: env.RETENTION_MODE,
    globalPause: env.RETENTION_ENFORCEMENT_PAUSED,
    batchSize: env.RETENTION_BATCH_SIZE,
    scanIntervalMs: env.PUBLIC_MEDIA_CLEANUP_SCAN_INTERVAL_MS,
  };
  return {
    ...(storage === undefined
      ? {}
      : { publicMedia: { storage, concurrency: env.PUBLIC_MEDIA_PROCESSING_CONCURRENCY } }),
    publicMediaCleanup,
  };
}
