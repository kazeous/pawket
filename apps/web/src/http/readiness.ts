const READINESS_TIMEOUT_MS = 2_000;

export type DependencyStatus = "up" | "down";

export type ReadinessResult = {
  status: "ready" | "not_ready";
  database: DependencyStatus;
  valkey: DependencyStatus;
  revision: string;
};

export type ReadinessDependencies = {
  checkDatabase: () => Promise<void>;
  checkValkey: () => Promise<void>;
  revision: string;
};

function withTimeout(check: () => Promise<void>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let checkPromise: Promise<void>;

  try {
    checkPromise = check();
  } catch (error) {
    return Promise.reject(error);
  }

  checkPromise.catch(() => undefined);

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("Readiness check timed out")), READINESS_TIMEOUT_MS);
  });

  return Promise.race([checkPromise, timeoutPromise]).finally(() => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  });
}

async function dependencyStatus(check: () => Promise<void>): Promise<DependencyStatus> {
  try {
    await withTimeout(check);
    return "up";
  } catch {
    return "down";
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
