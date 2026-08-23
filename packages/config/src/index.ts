import { z } from "zod";

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
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

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
      return "has an unsupported protocol";
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

  return parsed.data;
}

let loadedServerEnv: ServerEnv | undefined;

export function loadServerEnv(): ServerEnv {
  loadedServerEnv ??= parseServerEnv(process.env);
  return loadedServerEnv;
}
