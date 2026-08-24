import { describe, expect, it, vi } from "vitest";

import { parseServerEnv } from "../src/index.js";

const completeProductionEnv = {
  NODE_ENV: "production",
  APP_ENV: "production",
  APP_REVISION: "abc123",
  DATABASE_URL: "postgresql://pawket:secret@localhost:5432/pawket",
  VALKEY_URL: "redis://localhost:6379",
  METRICS_TOKEN: "12345678901234567890123456789012",
  APP_BASE_URL: "https://pawket.example",
  AUTH_TRUSTED_ORIGINS: "https://pawket.example,https://admin.pawket.example",
  BETTER_AUTH_SECRETS:
    "2:production-auth-secret-value-000000000002,1:production-auth-secret-value-000000000001",
  PII_ACTIVE_KEY_ID: "pii-2026-08",
  PII_KEYRING_JSON: JSON.stringify({
    "pii-2026-08": "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
  }),
  PII_LOOKUP_HMAC_KEY: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
  SECURITY_EMAIL_ADAPTER: "smtp",
  BOOTSTRAP_OWNER_EMAIL: "owner@pawket.example",
  VERIFICATION_DEPOSIT_AMOUNT_VND: "1000",
  OPERATING_BANK_BIN: "970436",
  OPERATING_BANK_ACCOUNT_NUMBER: "123456789",
  OPERATING_BANK_ACCOUNT_NAME: "PAWKET OPERATIONS",
  VN_BUSINESS_CALENDAR_VERSION: "vn-2026-approved-v1",
  VN_BUSINESS_HOLIDAYS: JSON.stringify(["2026-09-02"]),
  AUTH_USER_ABSOLUTE_TTL_SECONDS: "2592000",
  AUTH_USER_IDLE_TTL_SECONDS: "604800",
  AUTH_OWNER_ABSOLUTE_TTL_SECONDS: "43200",
  AUTH_OWNER_IDLE_TTL_SECONDS: "1800",
  AUTH_MFA_PENDING_TTL_SECONDS: "600",
  AUTH_PRIMARY_STEP_UP_TTL_SECONDS: "900",
  AUTH_OWNER_TOTP_STEP_UP_TTL_SECONDS: "300",
  AUTH_TOTP_MAX_FAILED_ATTEMPTS: "5",
  AUTH_TOTP_LOCKOUT_SECONDS: "900",
  AUTH_PASSWORD_RESET_TTL_SECONDS: "1800",
} as const;

const numericFields = [
  {
    field: "PORT",
    belowMinimum: 0,
    minimum: 1,
    maximum: 65535,
    aboveMaximum: 65536,
    defaultValue: 3000,
  },
  {
    field: "WORKER_CONCURRENCY",
    belowMinimum: 0,
    minimum: 1,
    maximum: 50,
    aboveMaximum: 51,
    defaultValue: 10,
  },
  {
    field: "OUTBOX_BATCH_SIZE",
    belowMinimum: 0,
    minimum: 1,
    maximum: 500,
    aboveMaximum: 501,
    defaultValue: 100,
  },
  {
    field: "OUTBOX_LEASE_MS",
    belowMinimum: 4999,
    minimum: 5000,
    maximum: 300000,
    aboveMaximum: 300001,
    defaultValue: 30000,
  },
] as const;

function expectSafeValidationError(
  input: Record<string, string>,
  field: string,
  reason: string,
  rejectedValue: string,
): void {
  let thrown: unknown;

  try {
    parseServerEnv(input);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  const message = (thrown as Error).message;
  expect(message).toContain(field);
  expect(message).toContain(reason);
  expect(message).not.toContain(rejectedValue);
}

describe("parseServerEnv", () => {
  it("parses a complete production environment", () => {
    // Catches a parser that leaves numeric values as strings or omits defaults.
    const parsed = parseServerEnv({ ...completeProductionEnv, PORT: "8080" });
    expect(parsed).toEqual(
      expect.objectContaining({
        NODE_ENV: "production",
        APP_ENV: "production",
        APP_REVISION: "abc123",
        LOG_LEVEL: "info",
        PORT: 8080,
        WORKER_CONCURRENCY: 10,
        OUTBOX_BATCH_SIZE: 100,
        OUTBOX_LEASE_MS: 30000,
        APP_BASE_URL: "https://pawket.example",
        AUTH_TRUSTED_ORIGINS: [
          "https://pawket.example",
          "https://admin.pawket.example",
        ],
        BETTER_AUTH_SECRETS: [
          { version: 2, value: "production-auth-secret-value-000000000002" },
          { version: 1, value: "production-auth-secret-value-000000000001" },
        ],
        PII_ACTIVE_KEY_ID: "pii-2026-08",
        PII_KEYRING_JSON: {
          "pii-2026-08": "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
        },
        VERIFICATION_DEPOSIT_AMOUNT_VND: 1000,
        VN_BUSINESS_HOLIDAYS: ["2026-09-02"],
        AUTH_OWNER_IDLE_TTL_SECONDS: 1800,
      }),
    );
  });

  it("uses explicit local-only defaults without adding phone or SMS configuration", () => {
    const local = parseServerEnv({
      NODE_ENV: "development",
      APP_ENV: "local",
      APP_REVISION: "local",
      DATABASE_URL: "postgresql://pawket:local@localhost:5432/pawket",
      VALKEY_URL: "redis://localhost:6379",
      METRICS_TOKEN: "local-metrics-token-123456789012345",
    });

    expect(local.APP_BASE_URL).toBe("http://localhost:3000");
    expect(local.SECURITY_EMAIL_ADAPTER).toBe("local");
    expect(Object.keys(local).join(" ")).not.toMatch(/phone|sms/i);
  });

  it("accepts provider-neutral SMTP settings without requiring them in the web process", () => {
    // Catches rejecting the approved production adapter or dropping its typed settings.
    const parsed = parseServerEnv({
      ...completeProductionEnv,
      SECURITY_EMAIL_ADAPTER: "smtp",
      SMTP_HOST: "smtp.transactional.example",
      SMTP_PORT: "587",
      SMTP_TLS_MODE: "starttls",
      SMTP_USERNAME: "pawket-production",
      SMTP_PASSWORD: "smtp-password-that-must-not-leak",
      SMTP_FROM_EMAIL: "security@pawket.example",
      SMTP_FROM_NAME: "Pawket Security",
    });

    expect(parsed).toEqual(
      expect.objectContaining({
        SECURITY_EMAIL_ADAPTER: "smtp",
        SMTP_HOST: "smtp.transactional.example",
        SMTP_PORT: 587,
        SMTP_TLS_MODE: "starttls",
        SMTP_USERNAME: "pawket-production",
        SMTP_PASSWORD: "smtp-password-that-must-not-leak",
        SMTP_FROM_EMAIL: "security@pawket.example",
        SMTP_FROM_NAME: "Pawket Security",
      }),
    );

    const webProcess = parseServerEnv({
      ...completeProductionEnv,
      SECURITY_EMAIL_ADAPTER: "smtp",
    });
    expect(webProcess.SECURITY_EMAIL_ADAPTER).toBe("smtp");
    expect(webProcess.SMTP_PASSWORD).toBeUndefined();
  });

  it("requires the approved SMTP adapter in production", () => {
    // Catches a production deployment silently disabling all identity email.
    expect(() =>
      parseServerEnv({
        ...completeProductionEnv,
        SECURITY_EMAIL_ADAPTER: "disabled",
      }),
    ).toThrow("SECURITY_EMAIL_ADAPTER must be smtp in production");
  });

  it("fails deployed configuration closed without echoing sensitive material", () => {
    const rejectedKeyring = '{"leaked-key":"not-a-real-key"}';
    expectSafeValidationError(
      { ...completeProductionEnv, PII_KEYRING_JSON: rejectedKeyring },
      "PII_KEYRING_JSON",
      "has an invalid format",
      rejectedKeyring,
    );
    expect(() =>
      parseServerEnv({ ...completeProductionEnv, APP_BASE_URL: "http://pawket.example" }),
    ).toThrow("APP_BASE_URL must use HTTPS when deployed");
  });

  it("requires OAuth credentials as an all-or-nothing provider pair", () => {
    const clientSecret = "provider-secret-that-must-not-leak";
    expect(() =>
      parseServerEnv({ ...completeProductionEnv, GOOGLE_CLIENT_SECRET: clientSecret }),
    ).toThrow("GOOGLE_CLIENT_ID must be configured as a complete provider pair");
    try {
      parseServerEnv({ ...completeProductionEnv, GOOGLE_CLIENT_SECRET: clientSecret });
    } catch (error) {
      expect((error as Error).message).not.toContain(clientSecret);
    }
  });

  it("treats blank optional OAuth variables from Compose as disabled providers", () => {
    const parsed = parseServerEnv({
      ...completeProductionEnv,
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "   ",
      DISCORD_CLIENT_ID: "",
      DISCORD_CLIENT_SECRET: "",
    });

    expect(parsed.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(parsed.GOOGLE_CLIENT_SECRET).toBeUndefined();
    expect(parsed.DISCORD_CLIENT_ID).toBeUndefined();
    expect(parsed.DISCORD_CLIENT_SECRET).toBeUndefined();
  });

  it("rejects a metrics token shorter than 32 characters without echoing it", () => {
    // Catches accepting a short token or including it in the validation error.
    const rejectedToken = "too-short";
    expectSafeValidationError(
      { ...completeProductionEnv, METRICS_TOKEN: rejectedToken },
      "METRICS_TOKEN",
      "is too short or too small",
      rejectedToken,
    );
  });

  it("rejects non-postgresql database URLs without echoing them", () => {
    // Catches accepting a reachable URL that is not a PostgreSQL connection.
    const rejectedDatabaseUrl = "https://localhost";
    expectSafeValidationError(
      { ...completeProductionEnv, DATABASE_URL: rejectedDatabaseUrl },
      "DATABASE_URL",
      "has an unsupported protocol",
      rejectedDatabaseUrl,
    );
  });

  it("rejects non-redis Valkey URLs without echoing them", () => {
    // Catches accepting a reachable URL that is not a Redis/Valkey connection.
    const rejectedValkeyUrl = "https://localhost";
    expectSafeValidationError(
      { ...completeProductionEnv, VALKEY_URL: rejectedValkeyUrl },
      "VALKEY_URL",
      "has an unsupported protocol",
      rejectedValkeyUrl,
    );
  });

  it.each(numericFields)("accepts the $field minimum", ({ field, minimum }) => {
    // Catches a lower bound that excludes its documented minimum.
    expect(parseServerEnv({ ...completeProductionEnv, [field]: String(minimum) })[field]).toBe(
      minimum,
    );
  });

  it.each(numericFields)("accepts the $field maximum", ({ field, maximum }) => {
    // Catches an upper bound that excludes its documented maximum.
    expect(parseServerEnv({ ...completeProductionEnv, [field]: String(maximum) })[field]).toBe(
      maximum,
    );
  });

  it.each(numericFields)("defaults $field safely", ({ field, defaultValue }) => {
    // Catches an omitted numeric setting receiving the wrong default.
    expect(parseServerEnv(completeProductionEnv)[field]).toBe(defaultValue);
  });

  it.each(numericFields)(
    "rejects $field below its minimum without echoing it",
    ({ field, belowMinimum }) => {
      // Catches a lower bound that permits an unsafe value.
      const rejectedValue = String(belowMinimum);
      expectSafeValidationError(
        { ...completeProductionEnv, [field]: rejectedValue },
        field,
        "is too short or too small",
        rejectedValue,
      );
    },
  );

  it.each(numericFields)(
    "rejects $field above its maximum without echoing it",
    ({ field, aboveMaximum }) => {
      // Catches an upper bound that permits an unsafe value.
      const rejectedValue = String(aboveMaximum);
      expectSafeValidationError(
        { ...completeProductionEnv, [field]: rejectedValue },
        field,
        "is too long or too large",
        rejectedValue,
      );
    },
  );
});

describe("loadServerEnv", () => {
  it("caches the first failed process environment result after process.env changes", async () => {
    // Catches reparsing after the initial configuration load fails.
    const originalEnv = process.env;

    try {
      vi.resetModules();
      process.env = { ...completeProductionEnv, METRICS_TOKEN: "too-short" };
      const { loadServerEnv } = await import("../src/index.js");

      expect(() => loadServerEnv()).toThrow("METRICS_TOKEN is too short or too small");

      process.env = { ...completeProductionEnv };

      expect(() => loadServerEnv()).toThrow("METRICS_TOKEN is too short or too small");
    } finally {
      process.env = originalEnv;
      vi.resetModules();
    }
  });
});
