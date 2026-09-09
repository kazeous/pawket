import { PUBLIC_MEDIA_WORKER_HEALTH_KEY } from "@pawket/queue";

type BrowserEnvironment = Readonly<Record<string, string | undefined>>;

export const INCREMENT_THREE_DISABLED_TEST =
  "increment-three-disabled.playwright.ts";
export const INCREMENT_THREE_ENABLED_TESTS = [
  "increment-three-acceptance.playwright.ts",
  "creator-page-management.playwright.ts",
  "public-creator-discovery.playwright.ts",
  "public-content-reporting.playwright.ts",
] as const;

export type IncrementThreeStorageFixture = Readonly<{
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  quarantineBucket: string;
  derivativeBucket: string;
  forcePathStyle: true;
}>;

const localFixture = {
  accessKeyId: "local-media-access-key",
  secretAccessKey: "local-media-secret-key",
  quarantineBucket: "pawket-media-quarantine",
  derivativeBucket: "pawket-media-derivatives",
} as const;

const ciFixture = {
  accessKeyId: "ci-media-access-key",
  secretAccessKey: "ci-media-secret-key",
  quarantineBucket: "pawket-ci-media-quarantine",
  derivativeBucket: "pawket-ci-media-derivatives",
} as const;

function unsafeStorageFixture(): never {
  throw new Error("Unsafe Increment 3 storage fixture configuration");
}

function isLoopback(url: URL): boolean {
  return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
}

export function resolveIncrementThreeStorageFixture(
  environment: BrowserEnvironment,
): IncrementThreeStorageFixture {
  const endpoint = environment.PUBLIC_MEDIA_S3_ENDPOINT ?? "http://127.0.0.1:9090";
  const region = environment.PUBLIC_MEDIA_S3_REGION ?? "us-east-1";
  const accessKeyId = environment.PUBLIC_MEDIA_S3_ACCESS_KEY_ID ?? localFixture.accessKeyId;
  const secretAccessKey =
    environment.PUBLIC_MEDIA_S3_SECRET_ACCESS_KEY ?? localFixture.secretAccessKey;
  const quarantineBucket =
    environment.PUBLIC_MEDIA_QUARANTINE_BUCKET ?? localFixture.quarantineBucket;
  const derivativeBucket =
    environment.PUBLIC_MEDIA_DERIVATIVE_BUCKET ?? localFixture.derivativeBucket;
  const forcePathStyle = environment.PUBLIC_MEDIA_S3_FORCE_PATH_STYLE ?? "true";
  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    return unsafeStorageFixture();
  }
  const selectedProfile = [localFixture, ciFixture].find(
    (profile) =>
      profile.accessKeyId === accessKeyId &&
      profile.secretAccessKey === secretAccessKey &&
      profile.quarantineBucket === quarantineBucket &&
      profile.derivativeBucket === derivativeBucket,
  );
  if (
    parsedEndpoint.protocol !== "http:" ||
    !isLoopback(parsedEndpoint) ||
    parsedEndpoint.port !== "9090" ||
    parsedEndpoint.username !== "" ||
    parsedEndpoint.password !== "" ||
    parsedEndpoint.pathname !== "/" ||
    parsedEndpoint.search !== "" ||
    parsedEndpoint.hash !== "" ||
    region !== "us-east-1" ||
    forcePathStyle !== "true" ||
    !selectedProfile
  ) {
    return unsafeStorageFixture();
  }
  return {
    endpoint,
    region,
    accessKeyId,
    secretAccessKey,
    quarantineBucket,
    derivativeBucket,
    forcePathStyle: true,
  };
}

export function incrementThreeStorageEnvironment(
  fixture: IncrementThreeStorageFixture,
): Readonly<Record<string, string>> {
  return {
    PUBLIC_MEDIA_S3_ENDPOINT: fixture.endpoint,
    PUBLIC_MEDIA_S3_REGION: fixture.region,
    PUBLIC_MEDIA_S3_ACCESS_KEY_ID: fixture.accessKeyId,
    PUBLIC_MEDIA_S3_SECRET_ACCESS_KEY: fixture.secretAccessKey,
    PUBLIC_MEDIA_QUARANTINE_BUCKET: fixture.quarantineBucket,
    PUBLIC_MEDIA_DERIVATIVE_BUCKET: fixture.derivativeBucket,
    PUBLIC_MEDIA_S3_FORCE_PATH_STYLE: "true",
  };
}

export function resolveIncrementThreeBrowserValkeyUrl(
  environment: BrowserEnvironment,
): string {
  const source =
    environment.PAWKET_BROWSER_VALKEY_URL ??
    environment.TEST_VALKEY_URL ??
    "redis://127.0.0.1:6379";
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    throw new Error("Unsafe Increment 3 browser Valkey configuration");
  }
  if (
    parsed.protocol !== "redis:" ||
    !isLoopback(parsed) ||
    parsed.port !== "6379" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    (parsed.pathname !== "" && parsed.pathname !== "/" && parsed.pathname !== "/0") ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("Unsafe Increment 3 browser Valkey configuration");
  }
  return source;
}

export async function clearIncrementThreeWorkerHealth(connection: {
  del(key: string): PromiseLike<number>;
}): Promise<void> {
  await connection.del(PUBLIC_MEDIA_WORKER_HEALTH_KEY);
}
