import { describe, expect, it } from "vitest";

import { parseServerEnv } from "../src/index.js";

const completeProductionEnv = {
  NODE_ENV: "production",
  APP_ENV: "production",
  APP_REVISION: "abc123",
  DATABASE_URL: "postgresql://pawket:secret@localhost:5432/pawket",
  VALKEY_URL: "redis://localhost:6379",
  METRICS_TOKEN: "12345678901234567890123456789012",
} as const;

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

  it("rejects a metrics token shorter than 32 characters", () => {
    // Catches accepting a token too short to serve as the metrics credential.
    expect(() =>
      parseServerEnv({ ...completeProductionEnv, METRICS_TOKEN: "too-short" }),
    ).toThrow();
  });

  it("rejects non-postgresql database URLs", () => {
    // Catches accepting a reachable URL that is not a PostgreSQL connection.
    expect(() =>
      parseServerEnv({ ...completeProductionEnv, DATABASE_URL: "https://localhost" }),
    ).toThrow();
  });

  it("rejects non-redis Valkey URLs", () => {
    // Catches accepting a reachable URL that is not a Redis/Valkey connection.
    expect(() =>
      parseServerEnv({ ...completeProductionEnv, VALKEY_URL: "https://localhost" }),
    ).toThrow();
  });

  it("applies bounded worker defaults", () => {
    // Catches missing or unsafe worker and outbox default values.
    const env = parseServerEnv(completeProductionEnv);

    expect(env.WORKER_CONCURRENCY).toBe(10);
    expect(env.OUTBOX_BATCH_SIZE).toBe(100);
    expect(env.OUTBOX_LEASE_MS).toBe(30000);
  });
});
