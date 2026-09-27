import { z } from "zod";

const integer = (minimum: number, maximum: number) => z.preprocess(
  (value) => typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value) ? Number(value) : value,
  z.number().int().min(minimum).max(maximum),
);
export const incrementSixEnvShape = {
  COMMISSION_INTAKE_MODE: z.enum(["disabled", "enabled"]).default("disabled"),
  COMMISSION_PAYMENTS_MODE: z.enum(["disabled", "manual_only", "sepay_optional"]).default("disabled"),
  COMMISSION_RECENT_AUTH_SECONDS: integer(60, 900).default(900),
  COMMISSION_TOTP_AUTH_SECONDS: integer(30, 300).default(300),
  COMMISSION_SCAN_BATCH_SIZE: integer(1, 500).default(100),
  COMMISSION_SCAN_INTERVAL_MS: integer(5_000, 300_000).default(60_000),
  COMMISSION_RATE_WINDOW_SECONDS: integer(60, 86_400).default(3_600),
  COMMISSION_REQUEST_LIMIT: integer(1, 100).default(20),
  COMMISSION_COMMAND_LIMIT: integer(1, 1_000).default(120),
  COMMISSION_READ_LIMIT: integer(1, 2_000).default(300),
};
type Parsed = z.infer<z.ZodObject<typeof incrementSixEnvShape>>;
export type IncrementSixServerEnv = Parsed;
export type CommissionIntakeMode = Parsed["COMMISSION_INTAKE_MODE"];
export type CommissionPaymentsMode = Parsed["COMMISSION_PAYMENTS_MODE"];
export class IncrementSixConfigError extends Error {
  constructor(readonly failures: ReadonlyArray<{ field: string; reason: string }>) {
    super(failures.map(({ field, reason }) => `${field} ${reason}`).join("; "));
    this.name = "IncrementSixConfigError";
  }
}
export function resolveIncrementSixEnv(parsed: Parsed & {
  PII_ACTIVE_KEY_ID?: string; PII_KEYRING_JSON?: Record<string, string>; PII_LOOKUP_HMAC_KEY?: string;
  AUTH_PRIMARY_STEP_UP_TTL_SECONDS?: number; AUTH_OWNER_TOTP_STEP_UP_TTL_SECONDS?: number;
}): IncrementSixServerEnv {
  const failures: Array<{ field: string; reason: string }> = [];
  if (parsed.COMMISSION_INTAKE_MODE === "enabled" || parsed.COMMISSION_PAYMENTS_MODE !== "disabled") {
    if (!parsed.PII_ACTIVE_KEY_ID || !parsed.PII_KEYRING_JSON?.[parsed.PII_ACTIVE_KEY_ID] || !parsed.PII_LOOKUP_HMAC_KEY) {
      failures.push({ field: "COMMISSION_INTAKE_MODE", reason: "commission activity requires the validated encryption keyring and lookup HMAC key" });
    }
  }
  if (parsed.COMMISSION_PAYMENTS_MODE !== "disabled") {
    if (parsed.AUTH_PRIMARY_STEP_UP_TTL_SECONDS === undefined || parsed.COMMISSION_RECENT_AUTH_SECONDS > parsed.AUTH_PRIMARY_STEP_UP_TTL_SECONDS) {
      failures.push({ field: "COMMISSION_RECENT_AUTH_SECONDS", reason: "requires and cannot exceed the primary identity step-up lifetime" });
    }
    if (parsed.AUTH_OWNER_TOTP_STEP_UP_TTL_SECONDS === undefined || parsed.COMMISSION_TOTP_AUTH_SECONDS > parsed.AUTH_OWNER_TOTP_STEP_UP_TTL_SECONDS) {
      failures.push({ field: "COMMISSION_TOTP_AUTH_SECONDS", reason: "requires and cannot exceed the identity TOTP step-up lifetime" });
    }
  }
  if (failures.length) throw new IncrementSixConfigError(failures);
  // Amounts, capacity and deadlines belong to the approved domain policy, not env overrides.
  // SePay credentials and capabilities remain independently gated by the existing provider contract.
  return Object.fromEntries(Object.keys(incrementSixEnvShape).map((key) => [key, parsed[key as keyof Parsed]])) as IncrementSixServerEnv;
}
