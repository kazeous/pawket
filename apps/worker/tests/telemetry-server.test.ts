import { afterEach, describe, expect, test } from "vitest";

import { startWorkerTelemetryServer, type WorkerTelemetryHandle } from "../src/telemetry-server.js";
import { createWorkerHealthState, workerReadiness } from "../src/worker-health.js";

const token = "worker-metrics-token-12345678901234567890";
const revision = {
  revision: "af05d661ef806fa7f2e3f63af12ad211e3d8b178",
  buildRevision: "af05d661ef806fa7f2e3f63af12ad211e3d8b178",
  revisionMatch: true,
} as const;

describe("worker telemetry server", () => {
  let handle: WorkerTelemetryHandle | undefined;

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
  });

  async function start() {
    const state = createWorkerHealthState();
    const now = Date.now();
    state.initializedAt = now;
    state.lastPollSucceededAt = now;
    state.lastRefundScanSucceededAt = now;
    handle = await startWorkerTelemetryServer({
      port: 0,
      host: "127.0.0.1",
      token,
      revision,
      state,
      registry: {
        contentType: "text/plain; version=0.0.4",
        metrics: async () => "pawket_worker_test_metric 1\n",
      },
    });
    return { state, baseUrl: `http://127.0.0.1:${handle.port}` };
  }

  test("serves liveness but rejects readiness when the Increment 3 cleanup scan is not configured", async () => {
    const { baseUrl } = await start();

    const live = await fetch(`${baseUrl}/health/live`);
    const ready = await fetch(`${baseUrl}/health/ready`);

    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: "ok", service: "worker", ...revision });
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({
      status: "not_ready",
      initialized: true,
      poll: "up",
      refundScan: "up",
      publicMediaCleanupScan: "not_configured",
      ...revision,
    });
  });

  test("includes configured public-media cleanup freshness in readiness", () => {
    const state = createWorkerHealthState();
    state.initializedAt = 1_000;
    state.lastPollSucceededAt = 1_000;
    state.lastRefundScanSucceededAt = 1_000;
    state.publicMediaCleanupConfigured = true;
    state.lastPublicMediaCleanupScanSucceededAt = 1_000;
    state.oldestPublicMediaCleanupCandidateAt = 500;
    state.publicMediaCleanupMaximumAgeMs = 1_000;

    expect(
      workerReadiness({
        state,
        revision,
        now: 1_500,
      }),
    ).toEqual(expect.objectContaining({
      status: "ready",
      publicMediaCleanupScan: "up",
    }));

    expect(
      workerReadiness({
        state,
        revision,
        now: 2_001,
      }),
    ).toEqual(expect.objectContaining({
      status: "not_ready",
      publicMediaCleanupScan: "down",
    }));
  });

  test("protects metrics with the shared bearer-token boundary", async () => {
    const { baseUrl } = await start();

    const denied = await fetch(`${baseUrl}/metrics`);
    const allowed = await fetch(`${baseUrl}/metrics`, {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(denied.status).toBe(401);
    expect(denied.headers.get("cache-control")).toBe("no-store");
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toContain("pawket_worker_test_metric 1");
  });

  test("fails readiness for stale polls, stopping workers, and revision mismatch", () => {
    const state = createWorkerHealthState();
    state.initializedAt = 1_000;
    state.lastPollSucceededAt = 1_000;
    state.lastRefundScanSucceededAt = 1_000;

    expect(
      workerReadiness({
        state,
        revision,
        now: 12_000,
        maximumPollAgeMs: 10_000,
        maximumRefundScanAgeMs: 20_000,
      }),
    ).toEqual(expect.objectContaining({ status: "not_ready", poll: "down" }));

    state.stopping = true;
    expect(workerReadiness({ state, revision, now: 1_000 }).status).toBe("not_ready");

    state.stopping = false;
    expect(
      workerReadiness({
        state,
        revision: { ...revision, buildRevision: "different", revisionMatch: false },
        now: 1_000,
      }).status,
    ).toBe("not_ready");
  });

  test("returns fixed responses for unsupported methods and paths", async () => {
    const { baseUrl } = await start();

    expect((await fetch(`${baseUrl}/unknown`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/health/live`, { method: "POST" })).status).toBe(405);
  });
});
