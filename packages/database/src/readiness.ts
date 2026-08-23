import postgres from "postgres";

const READINESS_TIMEOUT_SECONDS = 2;

type ReadinessClient = {
  unsafe(query: string): PromiseLike<unknown>;
  end(options: { timeout: number }): Promise<void>;
};

type ReadinessClientFactory = (databaseUrl: string) => ReadinessClient;

function defaultClientFactory(databaseUrl: string): ReadinessClient {
  return postgres(databaseUrl, {
    connect_timeout: READINESS_TIMEOUT_SECONDS,
    idle_timeout: READINESS_TIMEOUT_SECONDS,
    max: 1,
    connection: { statement_timeout: READINESS_TIMEOUT_SECONDS * 1_000 },
  });
}

export function createDatabaseReadinessCheck(
  databaseUrl: string,
  dependencies: { createClient?: ReadinessClientFactory } = {},
): (signal: AbortSignal) => Promise<void> {
  const createClient = dependencies.createClient ?? defaultClientFactory;

  return async (signal) => {
    const client = createClient(databaseUrl);
    let closePromise: Promise<void> | undefined;
    const close = () => {
      closePromise ??= client.end({ timeout: 0 });
      return closePromise;
    };
    const abortError = new Error("Database readiness check aborted");
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

    const query = Promise.resolve(client.unsafe("SELECT 1"));
    query.catch(() => undefined);

    try {
      await Promise.race([query, aborted]);
    } finally {
      removeAbortListener();
      await close();
    }
  };
}

export function checkDatabaseReadiness(databaseUrl: string, signal: AbortSignal): Promise<void> {
  return createDatabaseReadinessCheck(databaseUrl)(signal);
}
