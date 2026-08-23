import { afterEach, describe, expect, it, vi } from "vitest";

const routeDependencies = vi.hoisted(() => ({
  checkDatabaseReadiness: vi.fn(),
  closeReadinessConnection: vi.fn(),
  createReadinessConnection: vi.fn(),
  loadServerEnv: vi.fn(),
}));

vi.mock("@pawket/config", () => ({ loadServerEnv: routeDependencies.loadServerEnv }));
vi.mock("@pawket/database/readiness", () => ({
  checkDatabaseReadiness: routeDependencies.checkDatabaseReadiness,
}));
vi.mock("@pawket/queue/connection", () => ({
  closeReadinessConnection: routeDependencies.closeReadinessConnection,
  createReadinessConnection: routeDependencies.createReadinessConnection,
}));

describe("operational route wiring", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns liveness even when unrelated server configuration is invalid", async () => {
    vi.stubEnv("APP_REVISION", "live-revision");
    vi.stubEnv("DATABASE_URL", "not-a-postgres-url");
    vi.stubEnv("VALKEY_URL", "not-a-redis-url");
    vi.stubEnv("METRICS_TOKEN", "too-short");
    const { GET } = await import("../src/app/api/health/live/route.js");

    const response = await GET(new Request("http://localhost/api/health/live"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      service: "web",
      revision: "live-revision",
    });
  });

  it("uses unknown when the liveness revision is absent", async () => {
    vi.stubEnv("APP_REVISION", "");
    const { GET } = await import("../src/app/api/health/live/route.js");

    const response = await GET(new Request("http://localhost/api/health/live"));

    expect(await response.json()).toEqual({
      status: "ok",
      service: "web",
      revision: "unknown",
    });
  });

  it("wires the ready route through both dependency checks", async () => {
    routeDependencies.loadServerEnv.mockReturnValue({
      APP_REVISION: "ready-revision",
      DATABASE_URL: "postgresql://localhost/pawket",
      VALKEY_URL: "redis://localhost:6379",
    });
    routeDependencies.checkDatabaseReadiness.mockResolvedValue(undefined);
    routeDependencies.createReadinessConnection.mockReturnValue({
      connect: vi.fn().mockResolvedValue(undefined),
      ping: vi.fn().mockResolvedValue("PONG"),
      disconnect: vi.fn(),
    });
    routeDependencies.closeReadinessConnection.mockResolvedValue(undefined);
    const { GET } = await import("../src/app/api/health/ready/route.js");

    const response = await GET(new Request("http://localhost/api/health/ready"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ready",
      database: "up",
      valkey: "up",
      revision: "ready-revision",
    });
    expect(routeDependencies.checkDatabaseReadiness).toHaveBeenCalledWith(
      "postgresql://localhost/pawket",
      expect.any(AbortSignal),
    );
    expect(routeDependencies.createReadinessConnection).toHaveBeenCalledWith("redis://localhost:6379");
  });

  it("uses the metrics route handler for bearer authorization", async () => {
    routeDependencies.loadServerEnv.mockReturnValue({
      METRICS_TOKEN: "correct-metrics-token-12345678901234567890",
    });
    const { GET } = await import("../src/app/api/metrics/route.js");

    const denied = await GET(new Request("http://localhost/api/metrics"));
    const allowed = await GET(
      new Request("http://localhost/api/metrics", {
        headers: { authorization: "Bearer correct-metrics-token-12345678901234567890" },
      }),
    );

    expect(denied.status).toBe(401);
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toContain("pawket_http_requests_total");
  });
});
