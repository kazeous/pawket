import { z } from "zod";

const optional = (schema: z.ZodType<string>) => z.preprocess((value) => value === "" ? undefined : value, schema.optional());
const integer = (minimum: number, maximum: number) => z.preprocess(
  (value) => typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value) ? Number(value) : value,
  z.number().int().min(minimum).max(maximum),
);
export const incrementFiveEnvShape = {
  SEPAY_INGRESS_MODE: z.enum(["disabled", "enabled"]).default("disabled"),
  SEPAY_ENVIRONMENT: z.preprocess((value) => value === "" ? undefined : value, z.enum(["test", "live"]).optional()),
  SEPAY_OAUTH_CLIENT_ID: optional(z.string().min(1).max(200).regex(/^[A-Za-z0-9._-]+$/u)),
  SEPAY_OAUTH_CLIENT_SECRET: optional(z.string().min(16).max(4096).regex(/^[^\s\p{Cc}]+$/u)),
  SEPAY_OAUTH_REDIRECT_URI: optional(z.string().url().max(2048)),
  SEPAY_PROCESSING_BATCH_SIZE: integer(1, 100).default(25),
  SEPAY_PROCESSING_SCAN_INTERVAL_MS: integer(5_000, 300_000).default(30_000),
  SEPAY_PROCESSING_MAX_ATTEMPTS: integer(1, 10).default(5),
};
type Parsed = z.infer<z.ZodObject<typeof incrementFiveEnvShape>>;
export type IncrementFiveServerEnv = Parsed;
export class IncrementFiveConfigError extends Error {
  constructor(readonly failures: ReadonlyArray<{ field: string; reason: string }>) {
    super(failures.map(({ field, reason }) => `${field} ${reason}`).join("; "));
    this.name = "IncrementFiveConfigError";
  }
}
export function resolveIncrementFiveEnv(parsed: Parsed & {
  APP_BASE_URL: string; PII_ACTIVE_KEY_ID?: string; PII_KEYRING_JSON?: Record<string, string>; PII_LOOKUP_HMAC_KEY?: string;
}, appEnv: "local" | "test" | "staging" | "production"): IncrementFiveServerEnv {
  const failures: Array<{ field: string; reason: string }> = [];
  const clientFields = [parsed.SEPAY_OAUTH_CLIENT_ID, parsed.SEPAY_OAUTH_CLIENT_SECRET, parsed.SEPAY_OAUTH_REDIRECT_URI];
  if (clientFields.some(Boolean) && (!clientFields.every(Boolean) || !parsed.SEPAY_ENVIRONMENT)) {
    failures.push({ field: "SEPAY_OAUTH_CLIENT_ID", reason: "requires the client secret, exact redirect and provider environment together" });
  }
  if (parsed.SEPAY_ENVIRONMENT && ((appEnv === "production") !== (parsed.SEPAY_ENVIRONMENT === "live"))) {
    failures.push({ field: "SEPAY_ENVIRONMENT", reason: "must pair live with production and test with isolated non-production deployments" });
  }
  if (parsed.SEPAY_OAUTH_REDIRECT_URI) {
    const uri = new URL(parsed.SEPAY_OAUTH_REDIRECT_URI);
    const origin = new URL(parsed.APP_BASE_URL);
    if (uri.origin !== origin.origin || uri.pathname !== "/api/v1/creator/tips/sepay/callback" || uri.search || uri.hash || uri.username || uri.password ||
      (uri.protocol !== "https:" && !((appEnv === "local" || appEnv === "test") && uri.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(uri.hostname)))) {
      failures.push({ field: "SEPAY_OAUTH_REDIRECT_URI", reason: "must be the fixed same-origin callback without query, fragment or credentials" });
    }
  }
  if (parsed.SEPAY_INGRESS_MODE === "enabled") {
    if (!parsed.SEPAY_ENVIRONMENT) failures.push({ field: "SEPAY_INGRESS_MODE", reason: "requires an explicit isolated provider environment" });
    if (!parsed.PII_ACTIVE_KEY_ID || !parsed.PII_KEYRING_JSON?.[parsed.PII_ACTIVE_KEY_ID] || !parsed.PII_LOOKUP_HMAC_KEY) {
      failures.push({ field: "SEPAY_INGRESS_MODE", reason: "requires the validated encryption keyring and lookup HMAC key" });
    }
  }
  if (failures.length) throw new IncrementFiveConfigError(failures);
  // None of these values is evidence that SePay enforces PKCE or canonical IDs.
  // The provider adapter's capability contract remains an independent gate.
  return Object.fromEntries(Object.keys(incrementFiveEnvShape).map((key) => [key, parsed[key as keyof Parsed]])) as IncrementFiveServerEnv;
}
