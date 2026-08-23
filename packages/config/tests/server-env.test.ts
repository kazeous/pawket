import { describe, expect, it, vi } from "vitest";

import { parseServerEnv } from "../src/index.js";

const completeProductionEnv = {
  NODE_ENV: "production",
  APP_ENV: "production",
  APP_REVISION: "abc123",
  DATABASE_URL: "postgresql://pawket:secret@localhost:5432/pawket",
  VALKEY_URL: "redis://localhost:6379",
  METRICS_TOKEN: "12345678901234567890123456789012",
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
    expect(parseServerEnv({ ...completeProductionEnv, PORT: "8080" })).toEqual({
      ...completeProductionEnv,
      LOG_LEVEL: "info",
      PORT: 8080,
      WORKER_CONCURRENCY: 10,
      OUTBOX_BATCH_SIZE: 100,
      OUTBOX_LEASE_MS: 30000,
    });
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
