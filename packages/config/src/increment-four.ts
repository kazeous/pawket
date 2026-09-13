import { z } from "zod";

// Deployment strings must be canonical decimal integers. In particular blank,
// exponent, decimal and formatted values must never be coerced into valid VND.
const integerSetting = (minimum: number, maximum: number) => z.preprocess(
  (value) => typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value) ? Number(value) : value,
  z.number().int().min(minimum).max(maximum),
);

const presets = z.string().max(160).transform((value, context) => {
  try {
    const parsed: unknown = JSON.parse(value);
    const result = z.array(z.number().int().min(10_000).max(5_000_000)).min(3).max(10).safeParse(parsed);
    if (result.success && new Set(result.data).size === result.data.length) return result.data;
  } catch { /* Return a safe field-only validation error. */ }
  context.addIssue({ code: "custom" });
  return z.NEVER;
});

export const incrementFourEnvShape = {
  TIP_PAYMENTS_MODE: z.enum(["disabled", "manual_only"]).default("disabled"),
  TIP_AMOUNT_MIN_VND: integerSetting(10_000, 5_000_000).optional(),
  TIP_AMOUNT_MAX_VND: integerSetting(10_000, 5_000_000).optional(),
  TIP_SUGGESTED_PRESETS_VND: presets.optional(),
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
export type IncrementFourServerEnv = Omit<ParsedIncrementFourEnv,
  "TIP_AMOUNT_MIN_VND" | "TIP_AMOUNT_MAX_VND" | "TIP_SUGGESTED_PRESETS_VND"
> & {
  TIP_AMOUNT_MIN_VND: number;
  TIP_AMOUNT_MAX_VND: number;
  TIP_SUGGESTED_PRESETS_VND: ReadonlyArray<number>;
};

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
  appEnv: "local" | "test" | "staging" | "production",
): IncrementFourServerEnv {
  const failures: Array<{ field: string; reason: string }> = [];
  if (appEnv === "staging" || appEnv === "production") {
    for (const field of ["TIP_AMOUNT_MIN_VND", "TIP_AMOUNT_MAX_VND", "TIP_SUGGESTED_PRESETS_VND"] as const) {
      if (parsed[field] === undefined) failures.push({ field, reason: "must be explicitly configured when deployed" });
    }
  }
  const resolved: IncrementFourServerEnv = {
    ...parsed,
    TIP_AMOUNT_MIN_VND: parsed.TIP_AMOUNT_MIN_VND ?? 10_000,
    TIP_AMOUNT_MAX_VND: parsed.TIP_AMOUNT_MAX_VND ?? 5_000_000,
    TIP_SUGGESTED_PRESETS_VND: Object.freeze([...(parsed.TIP_SUGGESTED_PRESETS_VND ?? [20_000, 50_000, 100_000])]),
  };
  if (resolved.TIP_AMOUNT_MIN_VND > resolved.TIP_AMOUNT_MAX_VND) {
    failures.push({ field: "TIP_AMOUNT_MAX_VND", reason: "must be at least TIP_AMOUNT_MIN_VND" });
  }
  if (resolved.TIP_SUGGESTED_PRESETS_VND.some((amount) => amount < resolved.TIP_AMOUNT_MIN_VND || amount > resolved.TIP_AMOUNT_MAX_VND)) {
    failures.push({ field: "TIP_SUGGESTED_PRESETS_VND", reason: "must fall within the configured amount bounds" });
  }
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
