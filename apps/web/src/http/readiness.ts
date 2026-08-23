const READINESS_TIMEOUT_MS = 2_000;

export type DependencyStatus = "up" | "down";

export type ReadinessResult = {
  status: "ready" | "not_ready";
  database: DependencyStatus;
  valkey: DependencyStatus;
  revision: string;
};

export type ReadinessCheck = (signal: AbortSignal) => Promise<void>;

export type ReadinessDependencies = {
  checkDatabase: ReadinessCheck;
  checkValkey: ReadinessCheck;
  revision: string;
};

async function dependencyStatus(check: ReadinessCheck): Promise<DependencyStatus> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let checkPromise: Promise<void>;

  try {
    checkPromise = Promise.resolve(check(controller.signal));
  } catch {
    return "down";
  }

  // A dependency adapter may still reject after the probe has timed out. Keep
  // that rejection observed while the hard-deadline race returns the result.
  checkPromise.catch(() => undefined);

  const timeoutPromise = new Promise<DependencyStatus>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve("down");
    }, READINESS_TIMEOUT_MS);
  });

  try {
    return await Promise.race([
      checkPromise.then(
        () => "up" as const,
        () => "down" as const,
      ),
      timeoutPromise,
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export function createReadinessProbe(
  dependencies: ReadinessDependencies,
): () => Promise<ReadinessResult> {
  return async () => {
    const [database, valkey] = await Promise.all([
      dependencyStatus(dependencies.checkDatabase),
      dependencyStatus(dependencies.checkValkey),
    ]);

    return {
      status: database === "up" && valkey === "up" ? "ready" : "not_ready",
      database,
      valkey,
      revision: dependencies.revision,
    };
  };
}

function jsonResponse(body: object, status: number): Response {
  return Response.json(body, { status });
}

export function createLivenessResponse(revision: string): Response {
  return jsonResponse({ status: "ok", service: "web", revision }, 200);
}

export async function createReadinessResponse(
  probe: () => Promise<ReadinessResult>,
): Promise<Response> {
  const result = await probe();
  return jsonResponse(result, result.status === "ready" ? 200 : 503);
}
