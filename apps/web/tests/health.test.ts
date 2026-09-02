import net from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { metricsRegistry } from "@pawket/observability/metrics";

import {
  createLivenessResponse,
  createReadinessProbe,
  createReadinessResponse,
} from "../src/http/readiness.js";
import {
  createObjectStorageReadinessCheck,
  createValkeyReadinessCheck,
} from "../src/http/readiness-checks.js";

const revision = {
  revision: "revision-123",
  buildRevision: "revision-123",
  revisionMatch: true,
} as const;

describe("health probes", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the exact liveness payload without consulting dependencies", async () => {
    const response = createLivenessResponse(revision);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      service: "web",
      revision: "revision-123",
      buildRevision: "revision-123",
      revisionMatch: true,
    });
  });

  it("returns the exact ready payload when both dependencies are healthy", async () => {
    const probe = createReadinessProbe({
      checkDatabase: async () => undefined,
      checkValkey: async () => undefined,
      revision,
    });

    const response = await createReadinessResponse(probe);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ready",
      database: "up",
      valkey: "up",
      publicMediaStorage: "not_configured",
      revision: "revision-123",
      buildRevision: "revision-123",
      revisionMatch: true,
    });
  });

  it("reports a failed database without leaking its connection details", async () => {
    const probe = createReadinessProbe({
      checkDatabase: async () => {
        throw new Error("postgresql://artist:password@db.internal:5432/pawket");
      },
      checkValkey: async () => undefined,
      revision,
    });

    const response = await createReadinessResponse(probe);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(body)).toEqual({
      status: "not_ready",
      database: "down",
      valkey: "up",
      publicMediaStorage: "not_configured",
      revision: "revision-123",
      buildRevision: "revision-123",
      revisionMatch: true,
    });
    expect(body).not.toMatch(/postgresql|artist|password|db\.internal|pawket/i);
  });

  it("reports a failed Valkey while preserving the database result", async () => {
    const probe = createReadinessProbe({
      checkDatabase: async () => undefined,
      checkValkey: async () => {
        throw new Error("redis://:password@cache.internal:6379/0");
      },
      revision,
    });

    const response = await createReadinessResponse(probe);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "not_ready",
      database: "up",
      valkey: "down",
      publicMediaStorage: "not_configured",
      revision: "revision-123",
      buildRevision: "revision-123",
      revisionMatch: true,
    });
  });

  it("aborts a stalled dependency and waits for its cleanup before returning 503", async () => {
    vi.useFakeTimers();
    let observedAbort = false;
    let cleanupComplete = false;
    const probe = createReadinessProbe({
      checkDatabase: (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              cleanupComplete = true;
              reject(new Error("database connection destroyed"));
            },
            { once: true },
          );
        }),
      checkValkey: async () => undefined,
      revision,
    });

    const responsePromise = createReadinessResponse(probe);
    await vi.advanceTimersByTimeAsync(2_000);
    const response = await responsePromise;

    expect(observedAbort).toBe(true);
    expect(cleanupComplete).toBe(true);
    expect(response.status).toBe(503);
  });

  it("returns down at the hard deadline when a dependency ignores abort forever", async () => {
    vi.useFakeTimers();
    let observedAbort = false;
    const probe = createReadinessProbe({
      checkDatabase: (signal) =>
        new Promise<void>(() => {
          signal.addEventListener(
            "abort",
            () => {
              observedAbort = true;
            },
            { once: true },
          );
        }),
      checkValkey: async () => undefined,
      revision,
    });

    const responsePromise = createReadinessResponse(probe);
    await vi.advanceTimersByTimeAsync(2_000);
    const response = await responsePromise;

    expect(observedAbort).toBe(true);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "not_ready",
      database: "down",
      valkey: "up",
      publicMediaStorage: "not_configured",
      revision: "revision-123",
      buildRevision: "revision-123",
      revisionMatch: true,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails readiness when build and runtime revisions do not match", async () => {
    const probe = createReadinessProbe({
      checkDatabase: async () => undefined,
      checkValkey: async () => undefined,
      revision: {
        revision: "runtime-revision",
        buildRevision: "build-revision",
        revisionMatch: false,
      },
    });

    const response = await createReadinessResponse(probe);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "not_ready",
      database: "up",
      valkey: "up",
      publicMediaStorage: "not_configured",
      revision: "runtime-revision",
      buildRevision: "build-revision",
      revisionMatch: false,
    });
  });

  it("waits for asynchronous Valkey socket cleanup before rejecting an aborted check", async () => {
    let disconnected = false;
    let resolveCleanup: (() => void) | undefined;
    const cleanupComplete = new Promise<void>((resolve) => {
      resolveCleanup = resolve;
    });
    const controller = new AbortController();
    const check = createValkeyReadinessCheck("redis://localhost:6379", {
      createConnection: () => ({
        connect: async () => undefined,
        ping: () => new Promise<void>(() => undefined),
      }),
      closeConnection: async () => {
        disconnected = true;
        await cleanupComplete;
      },
    });

    const checkPromise = check(controller.signal);
    let settled = false;
    void checkPromise.catch(() => {
      settled = true;
    });
    controller.abort();

    await Promise.resolve();
    expect(disconnected).toBe(true);
    expect(settled).toBe(false);
    resolveCleanup?.();

    await expect(checkPromise).rejects.toThrow("aborted");
    expect(settled).toBe(true);
  });

  it("waits for a real ioredis socket to close before an aborted check settles", async () => {
    let socketClosed = false;
    let resolveAccepted: (() => void) | undefined;
    const accepted = new Promise<void>((resolve) => {
      resolveAccepted = resolve;
    });
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => {
        socketClosed = true;
        sockets.delete(socket);
      });
      resolveAccepted?.();
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Silent Valkey test server did not expose a TCP port");
      }
      const controller = new AbortController();
      const check = createValkeyReadinessCheck(`redis://127.0.0.1:${address.port}`);
      let settledBeforeSocketClose = false;
      const checkPromise = check(controller.signal).catch((error: unknown) => {
        settledBeforeSocketClose = !socketClosed;
        throw error;
      });

      await accepted;
      controller.abort();

      await expect(checkPromise).rejects.toBeInstanceOf(Error);
      expect(socketClosed).toBe(true);
      expect(settledBeforeSocketClose).toBe(false);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports storage diagnostically without gating readiness while publishing is disabled", async () => {
    // Catches a disabled-mode deployment that goes unready because Increment 3 buckets are absent.
    const probe = createReadinessProbe({
      checkDatabase: async () => undefined,
      checkValkey: async () => undefined,
      publishingMode: "disabled",
      checkPublicMediaStorage: async () => {
        throw new Error("storage area unavailable");
      },
      revision,
    });

    const response = await createReadinessResponse(probe);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ready",
      database: "up",
      valkey: "up",
      publicMediaStorage: "down",
      revision: "revision-123",
      buildRevision: "revision-123",
      revisionMatch: true,
    });
  });

  it("fails readiness when a public media bucket is unavailable and publishing is enabled", async () => {
    // Catches an enabled publishing surface serving pages while object storage is unreachable.
    const probe = createReadinessProbe({
      checkDatabase: async () => undefined,
      checkValkey: async () => undefined,
      publishingMode: "general_audience",
      checkPublicMediaStorage: async () => {
        throw new Error("storage area unavailable");
      },
      revision,
    });

    const response = await createReadinessResponse(probe);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "not_ready",
      database: "up",
      valkey: "up",
      publicMediaStorage: "down",
      revision: "revision-123",
      buildRevision: "revision-123",
      revisionMatch: true,
    });
  });

  it("probes both public media areas and publishes only closed area labels", async () => {
    // Catches a check that probes one bucket only, or that labels the gauge with bucket names.
    const probed: string[] = [];
    const check = createObjectStorageReadinessCheck({
      headBucket: async (area) => {
        probed.push(area);
      },
    });

    await expect(check(new AbortController().signal)).resolves.toBeUndefined();

    expect(probed).toEqual(["quarantine", "derivative"]);
    const metrics = await metricsRegistry.metrics();
    expect(metrics).toContain('pawket_public_media_storage_available{area="quarantine"} 1');
    expect(metrics).toContain('pawket_public_media_storage_available{area="derivative"} 1');
  });

  it("marks only the failing area unavailable without leaking bucket names", async () => {
    // Catches a check that reports success when one area is denied, or that echoes bucket hosts.
    const check = createObjectStorageReadinessCheck({
      headBucket: async (area) => {
        if (area === "derivative") {
          throw new Error("AccessDenied for pawket-public-derivatives.objects.example.com");
        }
      },
    });

    await expect(check(new AbortController().signal)).rejects.toThrow(
      "Public media storage is unavailable",
    );

    const metrics = await metricsRegistry.metrics();
    expect(metrics).toContain('pawket_public_media_storage_available{area="quarantine"} 1');
    expect(metrics).toContain('pawket_public_media_storage_available{area="derivative"} 0');
    expect(metrics).not.toMatch(/pawket-public-derivatives|objects\.example\.com/iu);
  });

  it("forwards the readiness abort signal to a hung bucket probe", async () => {
    // Catches a bucket probe that keeps running after the 2s readiness deadline has passed.
    vi.useFakeTimers();
    let observedAbort = false;
    const probe = createReadinessProbe({
      checkDatabase: async () => undefined,
      checkValkey: async () => undefined,
      publishingMode: "general_audience",
      checkPublicMediaStorage: createObjectStorageReadinessCheck({
        headBucket: (_area, signal) =>
          new Promise<void>(() => {
            signal?.addEventListener(
              "abort",
              () => {
                observedAbort = true;
              },
              { once: true },
            );
          }),
      }),
      revision,
    });

    const responsePromise = createReadinessResponse(probe);
    await vi.advanceTimersByTimeAsync(2_000);
    const response = await responsePromise;

    expect(observedAbort).toBe(true);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "not_ready",
      publicMediaStorage: "down",
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
