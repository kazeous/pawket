export const PUBLIC_MEDIA_WORKER_HEALTH_KEY = "pawket:health:public-media-cleanup:v1";
export const PUBLIC_MEDIA_WORKER_HEALTH_TTL_MS = 300_000;

const EXACT_REVISION = /^[0-9a-f]{40}$/u;

export type PublicMediaWorkerHealth = Readonly<{
  revision: string;
  scanSucceededAtMs: number;
}>;

type HealthWriter = Readonly<{
  set(
    key: string,
    value: string,
    expiryMode: "PX",
    expiryMilliseconds: number,
  ): PromiseLike<unknown>;
}>;

type HealthReader = Readonly<{
  get(key: string): PromiseLike<string | null>;
}>;

function validHealth(value: unknown): value is PublicMediaWorkerHealth {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === 2 &&
    keys.includes("revision") &&
    keys.includes("scanSucceededAtMs") &&
    typeof record.revision === "string" &&
    EXACT_REVISION.test(record.revision) &&
    Number.isSafeInteger(record.scanSucceededAtMs) &&
    (record.scanSucceededAtMs as number) >= 0
  );
}

export async function writePublicMediaWorkerHealth(
  connection: HealthWriter,
  health: PublicMediaWorkerHealth,
): Promise<void> {
  if (!validHealth(health)) throw new Error("Invalid public media worker health");
  await connection.set(
    PUBLIC_MEDIA_WORKER_HEALTH_KEY,
    JSON.stringify(health),
    "PX",
    PUBLIC_MEDIA_WORKER_HEALTH_TTL_MS,
  );
}

export async function readPublicMediaWorkerHealth(
  connection: HealthReader,
): Promise<PublicMediaWorkerHealth | null> {
  const serialized = await connection.get(PUBLIC_MEDIA_WORKER_HEALTH_KEY);
  if (serialized === null || serialized.length > 256) return null;
  try {
    const value: unknown = JSON.parse(serialized);
    return validHealth(value)
      ? { revision: value.revision, scanSucceededAtMs: value.scanSucceededAtMs }
      : null;
  } catch {
    return null;
  }
}
