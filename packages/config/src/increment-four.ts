import { z } from "zod";

// Deployment strings must be canonical decimal integers. In particular blank,
// exponent, decimal and formatted values cannot become operational limits.
const integerSetting = (minimum: number, maximum: number) => z.preprocess(
  (value) => typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value) ? Number(value) : value,
  z.number().int().min(minimum).max(maximum),
);

export const incrementFourEnvShape = {
  TIP_PAYMENTS_MODE: z.enum(["disabled", "manual_only"]).default("disabled"),
  TIP_INTENT_TTL_SECONDS: integerSetting(300, 604_800).default(86_400),
  TIP_GUEST_RECEIPT_TTL_SECONDS: integerSetting(3_600, 2_592_000).default(604_800),
  TIP_RECENT_AUTH_SECONDS: integerSetting(60, 900).default(900),
  TIP_TOTP_AUTH_SECONDS: integerSetting(30, 300).default(300),
  TIP_RATE_WINDOW_SECONDS: integerSetting(60, 86_400).default(3_600),
  TIP_CREATE_IP_LIMIT: integerSetting(1, 100).default(10),
  TIP_CREATE_CREATOR_LIMIT: integerSetting(1, 1_000).default(100),
  TIP_RECEIPT_REQUEST_LIMIT: integerSetting(1, 1_000).default(120),
  TIP_OPEN_IP_LIMIT: integerSetting(1, 20).default(3),
  TIP_OPEN_CREATOR_LIMIT: integerSetting(1, 10_000).default(1_000),
  TIP_QUEUE_PAGE_SIZE: integerSetting(1, 100).default(25),
  TIP_EXPIRY_BATCH_SIZE: integerSetting(1, 500).default(100),
  TIP_EXPIRY_SCAN_INTERVAL_MS: integerSetting(5_000, 300_000).default(60_000),
};

type ParsedIncrementFourEnv = z.infer<z.ZodObject<typeof incrementFourEnvShape>>;
export type TipPaymentsMode = ParsedIncrementFourEnv["TIP_PAYMENTS_MODE"];
export type IncrementFourServerEnv = ParsedIncrementFourEnv;

type PaymentDependencies = {
  PII_ACTIVE_KEY_ID?: string;
  PII_KEYRING_JSON?: Record<string, string>;
  PII_LOOKUP_HMAC_KEY?: string;
  AUTH_PRIMARY_STEP_UP_TTL_SECONDS?: number;
  AUTH_OWNER_TOTP_STEP_UP_TTL_SECONDS?: number;
};

export class IncrementFourConfigError extends Error {
  constructor(readonly failures: ReadonlyArray<{ field: string; reason: string }>) {
    super(failures.map(({ field, reason }) => `${field} ${reason}`).join("; "));
    this.name = "IncrementFourConfigError";
  }
}

export function resolveIncrementFourEnv(
  parsed: ParsedIncrementFourEnv & PaymentDependencies,
  _appEnv: "local" | "test" | "staging" | "production",
): IncrementFourServerEnv {
  void _appEnv; // Keep the environment resolver contract; amounts no longer vary by it.
  const failures: Array<{ field: string; reason: string }> = [];
  // Business amounts belong to the versioned database policy. Obsolete amount
  // environment variables cannot override it or prevent unrelated app startup.
  const resolved: IncrementFourServerEnv = parsed;
  if (resolved.TIP_GUEST_RECEIPT_TTL_SECONDS < resolved.TIP_INTENT_TTL_SECONDS) {
    failures.push({ field: "TIP_GUEST_RECEIPT_TTL_SECONDS", reason: "must cover the intent lifetime" });
  }
  if (resolved.TIP_PAYMENTS_MODE === "manual_only") {
    if (!parsed.PII_ACTIVE_KEY_ID || !parsed.PII_KEYRING_JSON?.[parsed.PII_ACTIVE_KEY_ID] || !parsed.PII_LOOKUP_HMAC_KEY) {
      failures.push({ field: "TIP_PAYMENTS_MODE", reason: "requires the validated encryption keyring and lookup HMAC key" });
    }
    if (parsed.AUTH_PRIMARY_STEP_UP_TTL_SECONDS === undefined || resolved.TIP_RECENT_AUTH_SECONDS > parsed.AUTH_PRIMARY_STEP_UP_TTL_SECONDS) {
      failures.push({ field: "TIP_RECENT_AUTH_SECONDS", reason: "requires and cannot exceed the primary identity step-up lifetime" });
    }
    if (parsed.AUTH_OWNER_TOTP_STEP_UP_TTL_SECONDS === undefined || resolved.TIP_TOTP_AUTH_SECONDS > parsed.AUTH_OWNER_TOTP_STEP_UP_TTL_SECONDS) {
      failures.push({ field: "TIP_TOTP_AUTH_SECONDS", reason: "requires and cannot exceed the identity TOTP step-up lifetime" });
    }
  }
  if (failures.length) throw new IncrementFourConfigError(failures);
  // Return only this module's fields, never the dependency key material passed
  // to validation. Config objects must not accidentally become key projections.
  return Object.fromEntries(Object.keys(incrementFourEnvShape).map((key) => [key, resolved[key as keyof IncrementFourServerEnv]])) as IncrementFourServerEnv;
}
