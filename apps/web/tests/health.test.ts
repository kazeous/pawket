import net from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLivenessResponse,
  createReadinessProbe,
  createReadinessResponse,
} from "../src/http/readiness.js";
import { createValkeyReadinessCheck } from "../src/http/readiness-checks.js";

describe("health probes", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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
      revision: "revision-123",
    });

    const responsePromise = createReadinessResponse(probe);
    await vi.advanceTimersByTimeAsync(2_000);
    const response = await responsePromise;

    expect(observedAbort).toBe(true);
    expect(cleanupComplete).toBe(true);
    expect(response.status).toBe(503);
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
});
