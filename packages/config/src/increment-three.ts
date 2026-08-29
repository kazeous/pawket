import { z } from "zod";

export type CreatorPublishingMode = "disabled" | "general_audience";
export type PublicMediaRetentionMode = "report_only" | "enforce";

export type IncrementThreeServerEnv = {
  CREATOR_PUBLISHING_MODE: CreatorPublishingMode;
  PUBLIC_MEDIA_S3_ENDPOINT?: string;
  PUBLIC_MEDIA_S3_REGION?: string;
  PUBLIC_MEDIA_S3_ACCESS_KEY_ID?: string;
  PUBLIC_MEDIA_S3_SECRET_ACCESS_KEY?: string;
  PUBLIC_MEDIA_QUARANTINE_BUCKET?: string;
  PUBLIC_MEDIA_DERIVATIVE_BUCKET?: string;
  PUBLIC_MEDIA_S3_FORCE_PATH_STYLE: boolean;
  PUBLIC_MEDIA_PROCESSING_CONCURRENCY: number;
  PUBLIC_MEDIA_CLEANUP_SCAN_INTERVAL_MS: number;
  PUBLIC_MEDIA_RETENTION_MODE: PublicMediaRetentionMode;
  PUBLIC_MEDIA_RETENTION_ACCEPTANCE_REFERENCE?: string;
};

const bucketNamePattern = /^(?!.*\.\.)[a-z0-9](?:[a-z0-9.-]{1,61})[a-z0-9]$/u;

const optionalBoundedString = (maximum = 2_048) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().min(1).max(maximum).optional(),
  );

export const incrementThreeEnvShape = {
  CREATOR_PUBLISHING_MODE: z.enum(["disabled", "general_audience"]).default("disabled"),
  PUBLIC_MEDIA_S3_ENDPOINT: optionalBoundedString(),
  PUBLIC_MEDIA_S3_REGION: optionalBoundedString(),
  PUBLIC_MEDIA_S3_ACCESS_KEY_ID: optionalBoundedString(),
  PUBLIC_MEDIA_S3_SECRET_ACCESS_KEY: optionalBoundedString(),
  PUBLIC_MEDIA_QUARANTINE_BUCKET: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().min(3).max(63).regex(bucketNamePattern).optional(),
  ),
  PUBLIC_MEDIA_DERIVATIVE_BUCKET: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().min(3).max(63).regex(bucketNamePattern).optional(),
  ),
  PUBLIC_MEDIA_S3_FORCE_PATH_STYLE: z
    .union([z.boolean(), z.enum(["true", "false"]).transform((value) => value === "true")])
    .default(true),
  PUBLIC_MEDIA_PROCESSING_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(2),
  PUBLIC_MEDIA_CLEANUP_SCAN_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(86_400_000)
    .default(21_600_000),
  PUBLIC_MEDIA_RETENTION_MODE: z.enum(["report_only", "enforce"]).default("report_only"),
  PUBLIC_MEDIA_RETENTION_ACCEPTANCE_REFERENCE: optionalBoundedString(2_048),
};

type ParsedIncrementThreeEnv = {
  [Key in keyof typeof incrementThreeEnvShape]?: z.infer<(typeof incrementThreeEnvShape)[Key]>;
} & {
  RETENTION_MODE?: "report_only" | "enforce";
  RETENTION_ENFORCEMENT_PAUSED?: boolean;
};

export class IncrementThreeConfigError extends Error {
  constructor(readonly failures: ReadonlyArray<{ field: string; reason: string }>) {
    super(failures.map(({ field, reason }) => `${field} ${reason}`).join("; "));
    this.name = "IncrementThreeConfigError";
  }
}

export function resolveIncrementThreeEnv(
  parsed: ParsedIncrementThreeEnv,
  appEnv: "local" | "test" | "staging" | "production",
): IncrementThreeServerEnv {
  const resolved = {
    CREATOR_PUBLISHING_MODE: "disabled",
    PUBLIC_MEDIA_S3_FORCE_PATH_STYLE: true,
    PUBLIC_MEDIA_PROCESSING_CONCURRENCY: 2,
    PUBLIC_MEDIA_CLEANUP_SCAN_INTERVAL_MS: 21_600_000,
    PUBLIC_MEDIA_RETENTION_MODE: "report_only",
    ...Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined)),
  } as IncrementThreeServerEnv;
  const failures: Array<{ field: string; reason: string }> = [];
  const deployed = appEnv === "staging" || appEnv === "production";

  if (deployed && resolved.CREATOR_PUBLISHING_MODE === "general_audience") {
    const requiredFields: Array<keyof IncrementThreeServerEnv> = [
      "PUBLIC_MEDIA_S3_ENDPOINT",
      "PUBLIC_MEDIA_S3_REGION",
      "PUBLIC_MEDIA_S3_ACCESS_KEY_ID",
      "PUBLIC_MEDIA_S3_SECRET_ACCESS_KEY",
      "PUBLIC_MEDIA_QUARANTINE_BUCKET",
      "PUBLIC_MEDIA_DERIVATIVE_BUCKET",
    ];
    for (const field of requiredFields) {
      if (!resolved[field]) failures.push({ field, reason: "is required when publishing is enabled" });
    }
    if (
      resolved.PUBLIC_MEDIA_QUARANTINE_BUCKET &&
      resolved.PUBLIC_MEDIA_QUARANTINE_BUCKET === resolved.PUBLIC_MEDIA_DERIVATIVE_BUCKET
    ) {
      failures.push({ field: "PUBLIC_MEDIA_DERIVATIVE_BUCKET", reason: "must differ from PUBLIC_MEDIA_QUARANTINE_BUCKET" });
    }
    if (resolved.PUBLIC_MEDIA_S3_ENDPOINT) {
      try {
        if (new URL(resolved.PUBLIC_MEDIA_S3_ENDPOINT).protocol !== "https:") {
          failures.push({ field: "PUBLIC_MEDIA_S3_ENDPOINT", reason: "must use HTTPS when deployed" });
        }
      } catch {
        failures.push({ field: "PUBLIC_MEDIA_S3_ENDPOINT", reason: "must be a valid URL" });
      }
    }
  }

  if (resolved.PUBLIC_MEDIA_RETENTION_MODE === "enforce") {
    if (parsed.RETENTION_MODE !== "enforce" || parsed.RETENTION_ENFORCEMENT_PAUSED !== false) {
      failures.push({
        field: "PUBLIC_MEDIA_RETENTION_MODE",
        reason: "enforce requires RETENTION_MODE=enforce and RETENTION_ENFORCEMENT_PAUSED=false",
      });
    }
    if (!resolved.PUBLIC_MEDIA_RETENTION_ACCEPTANCE_REFERENCE) {
      failures.push({
        field: "PUBLIC_MEDIA_RETENTION_MODE",
        reason: "enforce requires PUBLIC_MEDIA_RETENTION_ACCEPTANCE_REFERENCE",
      });
    }
  }

  if (failures.length > 0) throw new IncrementThreeConfigError(failures);
  return resolved;
}
