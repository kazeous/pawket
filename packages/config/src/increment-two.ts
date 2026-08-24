import { z } from "zod";

const keyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const calendarVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;
const localPiiKey = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
const localLookupKey = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=";

function addInvalidFormatIssue(context: z.RefinementCtx): typeof z.NEVER {
  context.addIssue({ code: "custom" });
  return z.NEVER;
}

function isCanonicalBase64Key(value: string): boolean {
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.length === 32 && decoded.toString("base64") === value;
  } catch {
    return false;
  }
}

function isDateOnly(value: string): boolean {
  if (!dateOnlyPattern.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const trustedOriginsSchema = z.string().max(2_048).transform((value, context) => {
  const origins = [...new Set(value.split(",").map((origin) => origin.trim()).filter(Boolean))];
  if (origins.length === 0 || origins.length > 10) return addInvalidFormatIssue(context);
  for (const origin of origins) {
    try {
      const url = new URL(origin);
      if (
        url.origin !== origin ||
        url.username ||
        url.password ||
        (url.protocol !== "http:" && url.protocol !== "https:")
      ) {
        return addInvalidFormatIssue(context);
      }
    } catch {
      return addInvalidFormatIssue(context);
    }
  }
  return origins;
});

const authSecretsSchema = z.string().max(2_048).transform((value, context) => {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length < 1 ||
      parsed.length > 3 ||
      parsed.some(
        (secret) =>
          typeof secret !== "string" || [...secret].length < 32 || [...secret].length > 512,
      ) ||
      new Set(parsed).size !== parsed.length
    ) {
      return addInvalidFormatIssue(context);
    }
    return parsed as string[];
  } catch {
    return addInvalidFormatIssue(context);
  }
});

const piiKeyringSchema = z.string().max(16_384).transform((value, context) => {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return addInvalidFormatIssue(context);
    }
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (
      entries.length < 1 ||
      entries.length > 8 ||
      entries.some(
        ([keyId, key]) =>
          !keyIdPattern.test(keyId) || typeof key !== "string" || !isCanonicalBase64Key(key),
      )
    ) {
      return addInvalidFormatIssue(context);
    }
    return Object.fromEntries(entries) as Record<string, string>;
  } catch {
    return addInvalidFormatIssue(context);
  }
});

const holidaysSchema = z.string().max(8_192).transform((value, context) => {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length > 64 ||
      parsed.some((date) => typeof date !== "string" || !isDateOnly(date)) ||
      new Set(parsed).size !== parsed.length
    ) {
      return addInvalidFormatIssue(context);
    }
    return [...parsed].sort() as string[];
  } catch {
    return addInvalidFormatIssue(context);
  }
});

const optionalBoundedInteger = (minimum: number, maximum: number) =>
  z.coerce.number().int().min(minimum).max(maximum).optional();

const optionalProviderValue = (maximum: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().min(1).max(maximum).optional(),
  );

const optionalEmailAddress = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.email().max(254).optional(),
);

export const incrementTwoEnvShape = {
  APP_BASE_URL: z.string().max(2_048).url().optional(),
  AUTH_TRUSTED_ORIGINS: trustedOriginsSchema.optional(),
  BETTER_AUTH_SECRETS: authSecretsSchema.optional(),
  PII_ACTIVE_KEY_ID: z.string().regex(keyIdPattern).optional(),
  PII_KEYRING_JSON: piiKeyringSchema.optional(),
  PII_LOOKUP_HMAC_KEY: z.string().max(128).refine(isCanonicalBase64Key).optional(),
  GOOGLE_CLIENT_ID: optionalProviderValue(512),
  GOOGLE_CLIENT_SECRET: optionalProviderValue(2048),
  DISCORD_CLIENT_ID: optionalProviderValue(512),
  DISCORD_CLIENT_SECRET: optionalProviderValue(2048),
  SECURITY_EMAIL_ADAPTER: z.enum(["disabled", "local", "smtp"]).optional(),
  SMTP_HOST: optionalProviderValue(253),
  SMTP_PORT: optionalBoundedInteger(1, 65_535),
  SMTP_TLS_MODE: z.enum(["starttls", "tls"]).optional(),
  SMTP_USERNAME: optionalProviderValue(512),
  SMTP_PASSWORD: optionalProviderValue(2_048),
  SMTP_FROM_EMAIL: optionalEmailAddress,
  SMTP_FROM_NAME: optionalProviderValue(100),
  BOOTSTRAP_OWNER_EMAIL: z.email().max(254).optional(),
  VERIFICATION_DEPOSIT_AMOUNT_VND: optionalBoundedInteger(1_000, 50_000),
  OPERATING_BANK_BIN: z.string().regex(/^\d{6}$/).optional(),
  OPERATING_BANK_ACCOUNT_NUMBER: z.string().regex(/^\d{6,19}$/).optional(),
  OPERATING_BANK_ACCOUNT_NAME: z.string().min(2).max(100).optional(),
  VN_BUSINESS_CALENDAR_VERSION: z.string().regex(calendarVersionPattern).optional(),
  VN_BUSINESS_HOLIDAYS: holidaysSchema.optional(),
  AUTH_USER_ABSOLUTE_TTL_SECONDS: optionalBoundedInteger(86_400, 5_184_000),
  AUTH_USER_IDLE_TTL_SECONDS: optionalBoundedInteger(3_600, 2_592_000),
  AUTH_OWNER_ABSOLUTE_TTL_SECONDS: optionalBoundedInteger(3_600, 86_400),
  AUTH_OWNER_IDLE_TTL_SECONDS: optionalBoundedInteger(300, 7_200),
  AUTH_MFA_PENDING_TTL_SECONDS: optionalBoundedInteger(120, 1_800),
  AUTH_PRIMARY_STEP_UP_TTL_SECONDS: optionalBoundedInteger(60, 3_600),
  AUTH_OWNER_TOTP_STEP_UP_TTL_SECONDS: optionalBoundedInteger(30, 900),
  AUTH_TOTP_MAX_FAILED_ATTEMPTS: optionalBoundedInteger(3, 10),
  AUTH_TOTP_LOCKOUT_SECONDS: optionalBoundedInteger(300, 3_600),
  AUTH_PASSWORD_RESET_TTL_SECONDS: optionalBoundedInteger(300, 3_600),
};

type ParsedIncrementTwoEnv = {
  [Key in keyof typeof incrementTwoEnvShape]?: z.infer<(typeof incrementTwoEnvShape)[Key]>;
};

export type IncrementTwoServerEnv = {
  APP_BASE_URL: string;
  AUTH_TRUSTED_ORIGINS: string[];
  BETTER_AUTH_SECRETS: string[];
  PII_ACTIVE_KEY_ID: string;
  PII_KEYRING_JSON: Record<string, string>;
  PII_LOOKUP_HMAC_KEY: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  SECURITY_EMAIL_ADAPTER: "disabled" | "local" | "smtp";
  SMTP_HOST?: string;
  SMTP_PORT?: number;
  SMTP_TLS_MODE?: "starttls" | "tls";
  SMTP_USERNAME?: string;
  SMTP_PASSWORD?: string;
  SMTP_FROM_EMAIL?: string;
  SMTP_FROM_NAME?: string;
  BOOTSTRAP_OWNER_EMAIL: string;
  VERIFICATION_DEPOSIT_AMOUNT_VND: number;
  OPERATING_BANK_BIN: string;
  OPERATING_BANK_ACCOUNT_NUMBER: string;
  OPERATING_BANK_ACCOUNT_NAME: string;
  VN_BUSINESS_CALENDAR_VERSION: string;
  VN_BUSINESS_HOLIDAYS: string[];
  AUTH_USER_ABSOLUTE_TTL_SECONDS: number;
  AUTH_USER_IDLE_TTL_SECONDS: number;
  AUTH_OWNER_ABSOLUTE_TTL_SECONDS: number;
  AUTH_OWNER_IDLE_TTL_SECONDS: number;
  AUTH_MFA_PENDING_TTL_SECONDS: number;
  AUTH_PRIMARY_STEP_UP_TTL_SECONDS: number;
  AUTH_OWNER_TOTP_STEP_UP_TTL_SECONDS: number;
  AUTH_TOTP_MAX_FAILED_ATTEMPTS: number;
  AUTH_TOTP_LOCKOUT_SECONDS: number;
  AUTH_PASSWORD_RESET_TTL_SECONDS: number;
};

const localDefaults: IncrementTwoServerEnv = {
  APP_BASE_URL: "http://localhost:3000",
  AUTH_TRUSTED_ORIGINS: ["http://localhost:3000"],
  BETTER_AUTH_SECRETS: ["local-only-better-auth-secret-000000000000"],
  PII_ACTIVE_KEY_ID: "local-pii-v1",
  PII_KEYRING_JSON: { "local-pii-v1": localPiiKey },
  PII_LOOKUP_HMAC_KEY: localLookupKey,
  SECURITY_EMAIL_ADAPTER: "local",
  BOOTSTRAP_OWNER_EMAIL: "owner@pawket.local",
  VERIFICATION_DEPOSIT_AMOUNT_VND: 1_000,
  OPERATING_BANK_BIN: "000000",
  OPERATING_BANK_ACCOUNT_NUMBER: "000000",
  OPERATING_BANK_ACCOUNT_NAME: "PAWKET LOCAL ONLY",
  VN_BUSINESS_CALENDAR_VERSION: "vn-local-v1",
  VN_BUSINESS_HOLIDAYS: [],
  AUTH_USER_ABSOLUTE_TTL_SECONDS: 2_592_000,
  AUTH_USER_IDLE_TTL_SECONDS: 604_800,
  AUTH_OWNER_ABSOLUTE_TTL_SECONDS: 43_200,
  AUTH_OWNER_IDLE_TTL_SECONDS: 1_800,
  AUTH_MFA_PENDING_TTL_SECONDS: 600,
  AUTH_PRIMARY_STEP_UP_TTL_SECONDS: 900,
  AUTH_OWNER_TOTP_STEP_UP_TTL_SECONDS: 300,
  AUTH_TOTP_MAX_FAILED_ATTEMPTS: 5,
  AUTH_TOTP_LOCKOUT_SECONDS: 900,
  AUTH_PASSWORD_RESET_TTL_SECONDS: 1_800,
};

const deployedRequiredFields: (keyof IncrementTwoServerEnv)[] = [
  "APP_BASE_URL",
  "AUTH_TRUSTED_ORIGINS",
  "BETTER_AUTH_SECRETS",
  "PII_ACTIVE_KEY_ID",
  "PII_KEYRING_JSON",
  "PII_LOOKUP_HMAC_KEY",
  "SECURITY_EMAIL_ADAPTER",
  "BOOTSTRAP_OWNER_EMAIL",
  "VERIFICATION_DEPOSIT_AMOUNT_VND",
  "OPERATING_BANK_BIN",
  "OPERATING_BANK_ACCOUNT_NUMBER",
  "OPERATING_BANK_ACCOUNT_NAME",
  "VN_BUSINESS_CALENDAR_VERSION",
  "VN_BUSINESS_HOLIDAYS",
  "AUTH_USER_ABSOLUTE_TTL_SECONDS",
  "AUTH_USER_IDLE_TTL_SECONDS",
  "AUTH_OWNER_ABSOLUTE_TTL_SECONDS",
  "AUTH_OWNER_IDLE_TTL_SECONDS",
  "AUTH_MFA_PENDING_TTL_SECONDS",
  "AUTH_PRIMARY_STEP_UP_TTL_SECONDS",
  "AUTH_OWNER_TOTP_STEP_UP_TTL_SECONDS",
  "AUTH_TOTP_MAX_FAILED_ATTEMPTS",
  "AUTH_TOTP_LOCKOUT_SECONDS",
  "AUTH_PASSWORD_RESET_TTL_SECONDS",
];

export class IncrementTwoConfigError extends Error {
  constructor(readonly failures: ReadonlyArray<{ field: string; reason: string }>) {
    super(failures.map(({ field, reason }) => `${field} ${reason}`).join("; "));
    this.name = "IncrementTwoConfigError";
  }
}

export function resolveIncrementTwoEnv(
  parsed: ParsedIncrementTwoEnv,
  appEnv: "local" | "test" | "staging" | "production",
): IncrementTwoServerEnv {
  const deployed = appEnv === "staging" || appEnv === "production";
  const failures: Array<{ field: string; reason: string }> = [];
  if (deployed) {
    for (const field of deployedRequiredFields) {
      if (parsed[field] === undefined) failures.push({ field, reason: "is required when deployed" });
    }
  }

  const supplied = Object.fromEntries(
    Object.entries(parsed).filter((entry) => entry[1] !== undefined),
  );
  const resolved = { ...localDefaults, ...supplied } as IncrementTwoServerEnv;
  const baseUrl = new URL(resolved.APP_BASE_URL);
  if (baseUrl.origin !== resolved.APP_BASE_URL || baseUrl.username || baseUrl.password) {
    failures.push({ field: "APP_BASE_URL", reason: "must be an exact origin" });
  }
  if (deployed && baseUrl.protocol !== "https:") {
    failures.push({ field: "APP_BASE_URL", reason: "must use HTTPS when deployed" });
  }
  if (!resolved.AUTH_TRUSTED_ORIGINS.includes(baseUrl.origin)) {
    failures.push({ field: "AUTH_TRUSTED_ORIGINS", reason: "must include APP_BASE_URL" });
  }
  if (deployed && resolved.AUTH_TRUSTED_ORIGINS.some((origin) => !origin.startsWith("https://"))) {
    failures.push({ field: "AUTH_TRUSTED_ORIGINS", reason: "must use HTTPS when deployed" });
  }
  if (!resolved.PII_KEYRING_JSON[resolved.PII_ACTIVE_KEY_ID]) {
    failures.push({ field: "PII_ACTIVE_KEY_ID", reason: "must exist in PII_KEYRING_JSON" });
  }
  for (const provider of ["GOOGLE", "DISCORD"] as const) {
    const clientId = parsed[`${provider}_CLIENT_ID`];
    const clientSecret = parsed[`${provider}_CLIENT_SECRET`];
    if ((clientId && !clientSecret) || (!clientId && clientSecret)) {
      failures.push({ field: `${provider}_CLIENT_ID`, reason: "must be configured as a complete provider pair" });
    }
  }
  if (deployed && resolved.SECURITY_EMAIL_ADAPTER === "local") {
    failures.push({ field: "SECURITY_EMAIL_ADAPTER", reason: "cannot use the local sink when deployed" });
  }
  if (appEnv === "production" && resolved.SECURITY_EMAIL_ADAPTER !== "smtp") {
    failures.push({ field: "SECURITY_EMAIL_ADAPTER", reason: "must be smtp in production" });
  }
  if (deployed && resolved.VN_BUSINESS_HOLIDAYS.length === 0) {
    failures.push({ field: "VN_BUSINESS_HOLIDAYS", reason: "must contain an approved deployed calendar" });
  }
  if (resolved.AUTH_USER_IDLE_TTL_SECONDS > resolved.AUTH_USER_ABSOLUTE_TTL_SECONDS) {
    failures.push({ field: "AUTH_USER_IDLE_TTL_SECONDS", reason: "cannot exceed the absolute lifetime" });
  }
  if (resolved.AUTH_OWNER_IDLE_TTL_SECONDS > resolved.AUTH_OWNER_ABSOLUTE_TTL_SECONDS) {
    failures.push({ field: "AUTH_OWNER_IDLE_TTL_SECONDS", reason: "cannot exceed the absolute lifetime" });
  }

  if (failures.length > 0) throw new IncrementTwoConfigError(failures);
  return resolved;
}
