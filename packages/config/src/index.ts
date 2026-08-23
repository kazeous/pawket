import { z } from "zod";

import {
  incrementTwoEnvShape,
  IncrementTwoConfigError,
  resolveIncrementTwoEnv,
  type IncrementTwoServerEnv,
} from "@pawket/config/increment-two";

const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  APP_ENV: z.enum(["local", "test", "staging", "production"]),
  APP_REVISION: z.string().min(1),
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
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(10),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
  OUTBOX_LEASE_MS: z.coerce.number().int().min(5000).max(300000).default(30000),
  ...incrementTwoEnvShape,
});

type ParsedServerEnv = z.infer<typeof serverEnvSchema>;
export type ServerEnv = Omit<ParsedServerEnv, keyof IncrementTwoServerEnv> &
  IncrementTwoServerEnv;

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
    return { ...parsed.data, ...incrementTwo } as ServerEnv;
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
