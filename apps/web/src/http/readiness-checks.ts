import {
  closeReadinessConnection,
  createReadinessConnection,
} from "@pawket/queue/connection";
import { readPublicMediaWorkerHealth } from "@pawket/queue/public-media-worker-health";
import { setPublicMediaStorageAvailabilityMetric } from "@pawket/observability";

type PublicMediaStorageArea = "quarantine" | "derivative";

type PublicMediaStorageProbe = {
  headBucket(area: PublicMediaStorageArea, signal?: AbortSignal): Promise<void>;
};

export function createObjectStorageReadinessCheck(
  storage: PublicMediaStorageProbe,
): (signal: AbortSignal) => Promise<void> {
  return async (signal) => {
    const areas = ["quarantine", "derivative"] as const;
    const results = await Promise.allSettled(
      areas.map((area) => storage.headBucket(area, signal)),
    );

    for (const [index, area] of areas.entries()) {
      setPublicMediaStorageAvailabilityMetric({
        area,
        available: results[index]?.status === "fulfilled",
      });
    }

    if (results.some((result) => result.status === "rejected")) {
      throw new Error("Public media storage is unavailable");
    }
  };
}

type ValkeyConnection = {
  connect(): PromiseLike<unknown>;
  ping(): PromiseLike<unknown>;
};

type ValkeyConnectionFactory = (valkeyUrl: string) => ValkeyConnection;
type ValkeyConnectionCloser = (connection: ValkeyConnection) => Promise<void>;

type WorkerHealthConnection = Pick<ValkeyConnection, "connect"> & {
  get(key: string): PromiseLike<string | null>;
};
type WorkerHealthConnectionFactory = (valkeyUrl: string) => WorkerHealthConnection;
type WorkerHealthConnectionCloser = (connection: WorkerHealthConnection) => Promise<void>;

export function createPublicMediaWorkerScanReadinessCheck(
  valkeyUrl: string,
  options: {
    expectedRevision: string;
    maximumScanAgeMs: number;
    now?: () => number;
    createConnection?: WorkerHealthConnectionFactory;
    closeConnection?: WorkerHealthConnectionCloser;
  },
): (signal: AbortSignal) => Promise<void> {
  const createConnection = options.createConnection ?? createReadinessConnection;
  const closeConnection: WorkerHealthConnectionCloser =
    options.closeConnection ??
    ((connection) =>
      closeReadinessConnection(connection as Parameters<typeof closeReadinessConnection>[0]));
  const now = options.now ?? Date.now;

  return async (signal) => {
    const connection = createConnection(valkeyUrl);
    let closePromise: Promise<void> | undefined;
    const close = () => {
      closePromise ??= closeConnection(connection);
      return closePromise;
    };
    const abortError = new Error("Public media worker scan check aborted");
    let removeAbortListener: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => {
        void close().then(
          () => reject(abortError),
          (error: unknown) => reject(error),
        );
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    });

    try {
      const connect = Promise.resolve(connection.connect());
      connect.catch(() => undefined);
      await Promise.race([connect, aborted]);
      const read = readPublicMediaWorkerHealth(connection);
      read.catch(() => undefined);
      const health = await Promise.race([read, aborted]);
      const checkedAt = now();
      if (
        health === null ||
        health.revision !== options.expectedRevision ||
        !Number.isSafeInteger(options.maximumScanAgeMs) ||
        options.maximumScanAgeMs < 1 ||
        health.scanSucceededAtMs > checkedAt ||
        checkedAt - health.scanSucceededAtMs > options.maximumScanAgeMs
      ) {
        throw new Error("Public media worker scan is unavailable");
      }
    } finally {
      removeAbortListener();
      await close();
    }
  };
}

export function createValkeyReadinessCheck(
  valkeyUrl: string,
  dependencies: {
    createConnection?: ValkeyConnectionFactory;
    closeConnection?: ValkeyConnectionCloser;
  } = {},
): (signal: AbortSignal) => Promise<void> {
  const createConnection = dependencies.createConnection ?? createReadinessConnection;
  const closeConnection: ValkeyConnectionCloser =
    dependencies.closeConnection ??
    ((connection) =>
      closeReadinessConnection(connection as Parameters<typeof closeReadinessConnection>[0]));

  return async (signal) => {
    const connection = createConnection(valkeyUrl);
    let closePromise: Promise<void> | undefined;
    const close = () => {
      closePromise ??= closeConnection(connection);
      return closePromise;
    };
    const abortError = new Error("Valkey readiness check aborted");
    let removeAbortListener: () => void = () => {};

    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => {
        void close().then(
          () => reject(abortError),
          (error: unknown) => reject(error),
        );
      };

      if (signal.aborted) {
        onAbort();
        return;
      }

      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    });

    const connect = Promise.resolve(connection.connect());
    connect.catch(() => undefined);

    try {
      await Promise.race([connect, aborted]);
      const ping = Promise.resolve(connection.ping());
      ping.catch(() => undefined);
      await Promise.race([ping, aborted]);
    } finally {
      removeAbortListener();
      await close();
    }
  };
}
