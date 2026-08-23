import { createReadinessConnection } from "@pawket/queue/connection";

type ValkeyConnection = {
  ping(): PromiseLike<unknown>;
  disconnect(): void;
};

type ValkeyConnectionFactory = (valkeyUrl: string) => ValkeyConnection;

export function createValkeyReadinessCheck(
  valkeyUrl: string,
  dependencies: { createConnection?: ValkeyConnectionFactory } = {},
): (signal: AbortSignal) => Promise<void> {
  const createConnection = dependencies.createConnection ?? createReadinessConnection;

  return async (signal) => {
    const connection = createConnection(valkeyUrl);
    let disconnected = false;
    const disconnect = () => {
      if (!disconnected) {
        disconnected = true;
        connection.disconnect();
      }
    };
    const abortError = new Error("Valkey readiness check aborted");
    let removeAbortListener: () => void = () => {};

    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => {
        disconnect();
        reject(abortError);
      };

      if (signal.aborted) {
        onAbort();
        return;
      }

      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    });

    const ping = Promise.resolve(connection.ping());
    ping.catch(() => undefined);

    try {
      await Promise.race([ping, aborted]);
    } finally {
      removeAbortListener();
      disconnect();
    }
  };
}
