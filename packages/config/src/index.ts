import { z } from "zod";

import {
  incrementTwoEnvShape,
  IncrementTwoConfigError,
  resolveIncrementTwoEnv,
  type IncrementTwoServerEnv,
} from "@pawket/config/increment-two";

const operationalIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

const optionalBoundedReference = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    return value.trim() === "" ? undefined : value;
  },
  z.string().min(1).max(200).regex(operationalIdentifierPattern).optional(),
);

const optionalOffsetTimestamp = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  },
  z.string().datetime({ offset: true }).optional(),
);

const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  APP_ENV: z.enum(["local", "test", "staging", "production"]),
  APP_REVISION: z.string().min(1),
  APP_BUILD_REVISION: z.string().min(1).optional(),
  DATABASE_URL: z
    .string()
    .url()
    .refine((value) => value.startsWith("postgresql://")),
  VALKEY_URL: z
    .string()
    .url()
    .refine((value) => value.startsWith("redis://") || value.startsWith("rediss://")),
  METRICS_TOKEN: z.string().min(32),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WORKER_TELEMETRY_PORT: z.coerce.number().int().min(1).max(65535).default(9464),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(10),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
  OUTBOX_LEASE_MS: z.coerce.number().int().min(5000).max(300000).default(30000),
  RETENTION_MODE: z.enum(["report_only", "enforce"]).default("report_only"),
  RETENTION_POLICY_VERSION: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).max(100).optional(),
  ),
  RETENTION_APPROVED_AT: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().datetime({ offset: true }).optional(),
  ),
  RETENTION_ENFORCEMENT_PAUSED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  RETENTION_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
  RETENTION_SCAN_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(86_400_000)
    .default(21_600_000),
  OWNER_MFA_RECOVERY_MODE: z.enum(["disabled", "external_manual"]).default("disabled"),
  OWNER_MFA_RECOVERY_ACCEPTANCE_REFERENCE: optionalBoundedReference,
  OWNER_MFA_RECOVERY_REHEARSED_AT: optionalOffsetTimestamp,
  ...incrementTwoEnvShape,
});

type ParsedServerEnv = z.infer<typeof serverEnvSchema>;
export type ServerEnv = Omit<
  ParsedServerEnv,
  keyof IncrementTwoServerEnv | "APP_BUILD_REVISION"
> &
  IncrementTwoServerEnv & { APP_BUILD_REVISION: string };

const exactSourceRevision = /^[0-9a-f]{40}$/u;

export type RevisionAttestation = Readonly<{
  revision: string;
  buildRevision: string;
  revisionMatch: boolean;
}>;

export function resolveRevisionAttestation(
  revision: string | undefined,
  buildRevision: string | undefined,
): RevisionAttestation {
  const normalizedRevision = revision?.trim() || "unknown";
  const normalizedBuildRevision = buildRevision?.trim() || "unknown";
  return {
    revision: normalizedRevision,
    buildRevision: normalizedBuildRevision,
    revisionMatch:
      normalizedRevision !== "unknown" &&
      normalizedBuildRevision !== "unknown" &&
      normalizedRevision === normalizedBuildRevision,
  };
}

function safeIssueReason(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "invalid_type":
      return "has an invalid type";
    case "invalid_value":
      return "is not an allowed value";
    case "too_small":
      return "is too short or too small";
    case "too_big":
      return "is too long or too large";
    case "invalid_format":
      return "has an invalid format";
    case "custom":
      return issue.path[0] === "DATABASE_URL" || issue.path[0] === "VALKEY_URL"
        ? "has an unsupported protocol"
        : "has an invalid format";
    default:
      return "is invalid";
  }
}

function formatValidationFailure(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "environment"} ${safeIssueReason(issue)}`)
    .join("; ");
}

export function parseServerEnv(
  input: NodeJS.ProcessEnv | Record<string, string | undefined>,
): ServerEnv {
  const parsed = serverEnvSchema.safeParse(input);

  if (!parsed.success) {
    throw new Error(`Invalid server environment: ${formatValidationFailure(parsed.error)}`);
  }

  try {
    const incrementTwo = resolveIncrementTwoEnv(parsed.data, parsed.data.APP_ENV);
    if (
      (parsed.data.APP_ENV === "production" || parsed.data.APP_ENV === "staging") &&
      parsed.data.NODE_ENV !== "production"
    ) {
      throw new IncrementTwoConfigError([
        { field: "NODE_ENV", reason: "must be production when deployed" },
      ]);
    }
    const buildRevision = parsed.data.APP_BUILD_REVISION ?? parsed.data.APP_REVISION;
    if (
      parsed.data.RETENTION_MODE === "enforce" &&
      (!parsed.data.RETENTION_POLICY_VERSION || !parsed.data.RETENTION_APPROVED_AT)
    ) {
      throw new IncrementTwoConfigError([
        {
          field: "RETENTION_MODE",
          reason: "enforce requires RETENTION_POLICY_VERSION and RETENTION_APPROVED_AT",
        },
      ]);
    }
    const recoveryAcceptanceConfigured =
      parsed.data.OWNER_MFA_RECOVERY_ACCEPTANCE_REFERENCE !== undefined;
    const recoveryRehearsalConfigured =
      parsed.data.OWNER_MFA_RECOVERY_REHEARSED_AT !== undefined;
    if (
      parsed.data.OWNER_MFA_RECOVERY_MODE === "external_manual" &&
      (!recoveryAcceptanceConfigured || !recoveryRehearsalConfigured)
    ) {
      throw new IncrementTwoConfigError([
        {
          field: "OWNER_MFA_RECOVERY_MODE",
          reason:
            "external_manual requires OWNER_MFA_RECOVERY_ACCEPTANCE_REFERENCE and OWNER_MFA_RECOVERY_REHEARSED_AT",
        },
      ]);
    }
    if (
      parsed.data.APP_ENV === "production" &&
      recoveryAcceptanceConfigured !== recoveryRehearsalConfigured
    ) {
      throw new IncrementTwoConfigError([
        {
          field: "OWNER_MFA_RECOVERY_ACCEPTANCE_REFERENCE",
          reason:
            "must be configured as a complete pair with OWNER_MFA_RECOVERY_REHEARSED_AT in production",
        },
      ]);
    }
    if (parsed.data.APP_ENV === "production") {
      const revisionFailures: Array<{ field: string; reason: string }> = [];
      if (!exactSourceRevision.test(parsed.data.APP_REVISION)) {
        revisionFailures.push({
          field: "APP_REVISION",
          reason: "must be the exact 40-character lowercase source commit in production",
        });
      }
      if (!parsed.data.APP_BUILD_REVISION || !exactSourceRevision.test(buildRevision)) {
        revisionFailures.push({
          field: "APP_BUILD_REVISION",
          reason: "must be embedded as the exact 40-character lowercase source commit in production",
        });
      }
      if (parsed.data.APP_REVISION !== buildRevision) {
        revisionFailures.push({
          field: "APP_REVISION",
          reason: "must match APP_BUILD_REVISION in production",
        });
      }
      if (revisionFailures.length > 0) {
        throw new IncrementTwoConfigError(revisionFailures);
      }
    }
    return {
      ...parsed.data,
      ...incrementTwo,
      APP_BUILD_REVISION: buildRevision,
    } as ServerEnv;
  } catch (error) {
    if (error instanceof IncrementTwoConfigError) {
      throw new Error(`Invalid server environment: ${error.message}`);
    }
    throw error;
  }
}

type ServerEnvLoadResult =
  | { success: true; value: ServerEnv }
  | { success: false; error: unknown };

let loadedServerEnv: ServerEnvLoadResult | undefined;

export function loadServerEnv(): ServerEnv {
  if (loadedServerEnv === undefined) {
    try {
      loadedServerEnv = { success: true, value: parseServerEnv(process.env) };
    } catch (error) {
      loadedServerEnv = { success: false, error };
    }
  }

  if (!loadedServerEnv.success) {
    throw loadedServerEnv.error;
  }

  return loadedServerEnv.value;
}
