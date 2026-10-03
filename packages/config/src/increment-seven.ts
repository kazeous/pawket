import { z } from "zod";

const integer = (minimum: number, maximum: number) => z.preprocess(
  (value) => typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value) ? Number(value) : value,
  z.number().int().min(minimum).max(maximum),
);
const blankToUndefined = (value: unknown) => typeof value === "string" && value.trim() === "" ? undefined : value;
const optionalText = (maximum: number) => z.preprocess(blankToUndefined, z.string().min(1).max(maximum).optional());
const bucketNamePattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/u;
const optionalBucket = z.preprocess(blankToUndefined, z.string().min(3).max(63).regex(bucketNamePattern).optional());
const hostPattern = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/u;
const referencePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

export const incrementSevenEnvShape = {
  COMMISSION_FILES_MODE: z.enum(["disabled", "enabled"]).default("disabled"),
  COMMISSION_FILE_RETENTION_MODE: z.enum(["report_only", "enforce"]).default("report_only"),
  COMMISSION_FILE_RETENTION_ACCEPTANCE_REFERENCE: z.preprocess(blankToUndefined, z.string().regex(referencePattern).optional()),
  COMMISSION_FILES_S3_ENDPOINT: optionalText(2_048),
  COMMISSION_FILES_S3_REGION: optionalText(128),
  COMMISSION_FILES_S3_ACCESS_KEY_ID: optionalText(256),
  COMMISSION_FILES_S3_SECRET_ACCESS_KEY: optionalText(512),
  COMMISSION_FILES_QUARANTINE_BUCKET: optionalBucket,
  COMMISSION_FILES_CLEAN_BUCKET: optionalBucket,
  COMMISSION_FILES_S3_FORCE_PATH_STYLE: z.union([z.boolean(), z.enum(["true", "false"]).transform((value) => value === "true")]).default(true),
  COMMISSION_FILES_CLAMD_HOST: z.preprocess(blankToUndefined, z.string().regex(hostPattern).optional()),
  COMMISSION_FILES_CLAMD_PORT: integer(1, 65_535).default(3310),
  COMMISSION_FILES_SCAN_CONCURRENCY: integer(1, 2).default(1),
  COMMISSION_FILES_SCAN_TIMEOUT_MS: integer(30_000, 900_000).default(300_000),
  COMMISSION_FILES_MAINTENANCE_INTERVAL_MS: integer(10_000, 600_000).default(60_000),
  COMMISSION_FILES_MAINTENANCE_BATCH_SIZE: integer(1, 500).default(100),
  COMMISSION_FILES_GRANT_LIMIT: integer(1, 1_000).default(60),
};
type Parsed = z.infer<z.ZodObject<typeof incrementSevenEnvShape>>;
export type IncrementSevenServerEnv = Parsed;
export type CommissionFilesMode = Parsed["COMMISSION_FILES_MODE"];
export type CommissionFileRetentionMode = Parsed["COMMISSION_FILE_RETENTION_MODE"];
export class IncrementSevenConfigError extends Error {
  constructor(readonly failures: ReadonlyArray<{ field: string; reason: string }>) {
    super(failures.map(({ field, reason }) => `${field} ${reason}`).join("; "));
    this.name = "IncrementSevenConfigError";
  }
}
export function resolveIncrementSevenEnv(parsed: Parsed & {
  APP_ENV: "local" | "test" | "staging" | "production";
  PII_ACTIVE_KEY_ID?: string; PII_KEYRING_JSON?: Record<string, string>; PII_LOOKUP_HMAC_KEY?: string;
}): IncrementSevenServerEnv {
  const failures: Array<{ field: string; reason: string }> = [];
  if (parsed.COMMISSION_FILES_MODE === "enabled") {
    if (!parsed.PII_ACTIVE_KEY_ID || !parsed.PII_KEYRING_JSON?.[parsed.PII_ACTIVE_KEY_ID] || !parsed.PII_LOOKUP_HMAC_KEY) {
      failures.push({ field: "COMMISSION_FILES_MODE", reason: "requires the validated encryption keyring and lookup HMAC key" });
    }
    for (const field of ["COMMISSION_FILES_S3_ENDPOINT", "COMMISSION_FILES_S3_REGION", "COMMISSION_FILES_S3_ACCESS_KEY_ID", "COMMISSION_FILES_S3_SECRET_ACCESS_KEY",
      "COMMISSION_FILES_QUARANTINE_BUCKET", "COMMISSION_FILES_CLEAN_BUCKET"] as const) {
      if (!parsed[field]) failures.push({ field, reason: "is required when commission files are enabled" });
    }
    if (parsed.COMMISSION_FILES_QUARANTINE_BUCKET && parsed.COMMISSION_FILES_QUARANTINE_BUCKET === parsed.COMMISSION_FILES_CLEAN_BUCKET) {
      failures.push({ field: "COMMISSION_FILES_CLEAN_BUCKET", reason: "must differ from the quarantine bucket" });
    }
    if (parsed.COMMISSION_FILES_S3_ENDPOINT) {
      let protocol = "";
      try { protocol = new URL(parsed.COMMISSION_FILES_S3_ENDPOINT).protocol; } catch { failures.push({ field: "COMMISSION_FILES_S3_ENDPOINT", reason: "must be a URL" }); }
      if (protocol && protocol !== "https:" && (parsed.APP_ENV === "production" || parsed.APP_ENV === "staging")) {
        failures.push({ field: "COMMISSION_FILES_S3_ENDPOINT", reason: "must use https when deployed" });
      }
    }
  }
  if (parsed.COMMISSION_FILE_RETENTION_MODE === "enforce" && !parsed.COMMISSION_FILE_RETENTION_ACCEPTANCE_REFERENCE) {
    failures.push({ field: "COMMISSION_FILE_RETENTION_ACCEPTANCE_REFERENCE", reason: "is required before file retention can be enforced" });
  }
  if (failures.length) throw new IncrementSevenConfigError(failures);
  // The ClamAV host is validated by the worker, which is the only process that connects to it.
  return Object.fromEntries(Object.keys(incrementSevenEnvShape).map((key) => [key, parsed[key as keyof Parsed]])) as IncrementSevenServerEnv;
}
