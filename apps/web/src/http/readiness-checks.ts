import {
  closeReadinessConnection,
  createReadinessConnection,
} from "@pawket/queue/connection";

type ValkeyConnection = {
  connect(): PromiseLike<unknown>;
  ping(): PromiseLike<unknown>;
};

type ValkeyConnectionFactory = (valkeyUrl: string) => ValkeyConnection;
type ValkeyConnectionCloser = (connection: ValkeyConnection) => Promise<void>;

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
