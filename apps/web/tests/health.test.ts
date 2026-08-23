import { describe, expect, it } from "vitest";

import {
  createLivenessResponse,
  createReadinessProbe,
  createReadinessResponse,
} from "../src/http/readiness.js";

describe("health probes", () => {
  it("returns the exact liveness payload without consulting dependencies", async () => {
    const response = createLivenessResponse("revision-123");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      service: "web",
      revision: "revision-123",
    });
  });

  it("returns the exact ready payload when both dependencies are healthy", async () => {
    const probe = createReadinessProbe({
      checkDatabase: async () => undefined,
      checkValkey: async () => undefined,
      revision: "revision-123",
    });

    const response = await createReadinessResponse(probe);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ready",
      database: "up",
      valkey: "up",
      revision: "revision-123",
    });
  });

  it("reports a failed database without leaking its connection details", async () => {
    const probe = createReadinessProbe({
      checkDatabase: async () => {
        throw new Error("postgresql://artist:password@db.internal:5432/pawket");
      },
      checkValkey: async () => undefined,
      revision: "revision-123",
    });

    const response = await createReadinessResponse(probe);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(body)).toEqual({
      status: "not_ready",
      database: "down",
      valkey: "up",
      revision: "revision-123",
    });
    expect(body).not.toMatch(/postgresql|artist|password|db\.internal|pawket/i);
  });

  it("reports a failed Valkey while preserving the database result", async () => {
    const probe = createReadinessProbe({
      checkDatabase: async () => undefined,
      checkValkey: async () => {
        throw new Error("redis://:password@cache.internal:6379/0");
      },
      revision: "revision-123",
    });

    const response = await createReadinessResponse(probe);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "not_ready",
      database: "up",
      valkey: "down",
      revision: "revision-123",
    });
  });
});
