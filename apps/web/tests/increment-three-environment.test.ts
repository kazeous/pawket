import { readFileSync } from "node:fs";

import { describe, expect, test, vi } from "vitest";

import { PUBLIC_MEDIA_WORKER_HEALTH_KEY } from "@pawket/queue";

import * as environmentHarness from "./increment-three-environment";
import * as globalSetupHarness from "./increment-three-global-setup";

type Environment = Readonly<Record<string, string | undefined>>;
type StorageFixture = Readonly<{
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  quarantineBucket: string;
  derivativeBucket: string;
  forcePathStyle: true;
}>;

function resolveStorage(environment: Environment): StorageFixture {
  const resolver = (
    environmentHarness as unknown as {
      resolveIncrementThreeStorageFixture?: (input: Environment) => StorageFixture;
    }
  ).resolveIncrementThreeStorageFixture;
  if (!resolver) throw new Error("Increment 3 storage fixture resolver is missing");
  return resolver(environment);
}

describe("Increment 3 browser environment isolation", () => {
  test("defines disjoint enabled, disabled, and legacy browser discovery", () => {
    // Break caught: the acceptance journey is silently skipped or runs under disabled/legacy settings.
    const enabled = (
      environmentHarness as unknown as {
        INCREMENT_THREE_ENABLED_TESTS?: readonly string[];
      }
    ).INCREMENT_THREE_ENABLED_TESTS;
    const disabled = (
      environmentHarness as unknown as {
        INCREMENT_THREE_DISABLED_TEST?: string;
      }
    ).INCREMENT_THREE_DISABLED_TEST;
    if (!enabled || !disabled) throw new Error("Increment 3 browser discovery contract is missing");

    expect(enabled).toEqual([
      "increment-three-acceptance.playwright.ts",
      "creator-page-management.playwright.ts",
      "public-creator-discovery.playwright.ts",
      "public-content-reporting.playwright.ts",
    ]);
    expect(disabled).toBe("increment-three-disabled.playwright.ts");
    expect(enabled).not.toContain(disabled);
  });

  test("defaults to the dedicated loopback S3Mock fixture", () => {
    // Break caught: local setup and runtime silently diverge on endpoint, buckets, or credentials.
    expect(resolveStorage({})).toEqual({
      endpoint: "http://127.0.0.1:9090",
      region: "us-east-1",
      accessKeyId: "local-media-access-key",
      secretAccessKey: "local-media-secret-key",
      quarantineBucket: "pawket-media-quarantine",
      derivativeBucket: "pawket-media-derivatives",
      forcePathStyle: true,
    });
  });

  test("round-trips the synthetic CI fixture through the shared runtime environment", () => {
    // Break caught: CI creates one S3Mock bucket pair while the web or worker uses another.
    const ciEnvironment = {
      PUBLIC_MEDIA_S3_ENDPOINT: "http://127.0.0.1:9090",
      PUBLIC_MEDIA_S3_REGION: "us-east-1",
      PUBLIC_MEDIA_S3_ACCESS_KEY_ID: "ci-media-access-key",
      PUBLIC_MEDIA_S3_SECRET_ACCESS_KEY: "ci-media-secret-key",
      PUBLIC_MEDIA_QUARANTINE_BUCKET: "pawket-ci-media-quarantine",
      PUBLIC_MEDIA_DERIVATIVE_BUCKET: "pawket-ci-media-derivatives",
      PUBLIC_MEDIA_S3_FORCE_PATH_STYLE: "true",
    } as const;
    const toEnvironment = (
      environmentHarness as unknown as {
        incrementThreeStorageEnvironment?: (fixture: StorageFixture) => Environment;
      }
    ).incrementThreeStorageEnvironment;
    if (!toEnvironment) throw new Error("Increment 3 storage environment mapper is missing");

    expect(resolveStorage(toEnvironment(resolveStorage(ciEnvironment)))).toEqual(
      resolveStorage(ciEnvironment),
    );
  });

  test.each([
    {
      label: "a non-loopback object store",
      environment: { PUBLIC_MEDIA_S3_ENDPOINT: "https://s3.example.test" },
    },
    {
      label: "non-synthetic credentials",
      environment: {
        PUBLIC_MEDIA_S3_ACCESS_KEY_ID: "AKIAEXAMPLEPRODUCTION",
        PUBLIC_MEDIA_S3_SECRET_ACCESS_KEY: "production-looking-secret",
      },
    },
    {
      label: "an unrelated bucket",
      environment: { PUBLIC_MEDIA_DERIVATIVE_BUCKET: "customer-media" },
    },
    {
      label: "a non-path-style client",
      environment: { PUBLIC_MEDIA_S3_FORCE_PATH_STYLE: "false" },
    },
  ])("rejects $label before fixture setup", ({ environment }) => {
    // Break caught: destructive fixture setup reaches storage outside its approved disposable namespace.
    expect(() => resolveStorage(environment)).toThrow(
      "Unsafe Increment 3 storage fixture configuration",
    );
  });

  test("accepts only a loopback browser Valkey target", () => {
    // Break caught: heartbeat cleanup deletes the fixed key from a shared or remote Valkey instance.
    const resolveValkey = (
      environmentHarness as unknown as {
        resolveIncrementThreeBrowserValkeyUrl?: (input: Environment) => string;
      }
    ).resolveIncrementThreeBrowserValkeyUrl;
    if (!resolveValkey) throw new Error("Increment 3 browser Valkey resolver is missing");
    expect(resolveValkey({})).toBe("redis://127.0.0.1:6379");
    expect(() =>
      resolveValkey({ PAWKET_BROWSER_VALKEY_URL: "redis://valkey.example.test:6379" }),
    ).toThrow("Unsafe Increment 3 browser Valkey configuration");
  });

  test("clears only the fixed public-media worker health key", async () => {
    // Break caught: a previous same-revision scan can satisfy readiness after the database reset.
    const clearHealth = (
      environmentHarness as unknown as {
        clearIncrementThreeWorkerHealth?: (connection: {
          del(key: string): Promise<number>;
        }) => Promise<void>;
      }
    ).clearIncrementThreeWorkerHealth;
    if (!clearHealth) throw new Error("Increment 3 worker health reset is missing");
    const connection = { del: vi.fn(async () => 1) };

    await clearHealth(connection);

    expect(connection.del).toHaveBeenCalledOnce();
    expect(connection.del).toHaveBeenCalledWith(PUBLIC_MEDIA_WORKER_HEALTH_KEY);
  });

  test("prepares the browser database before seeding Increment 3 state", async () => {
    // Break caught: config evaluation resets the database after global setup has seeded it.
    const runSetup = (
      globalSetupHarness as unknown as {
        prepareAndResetIncrementThreeState?: (dependencies: {
          prepareDatabase(): Promise<void>;
          resetState(): Promise<void>;
        }) => Promise<void>;
      }
    ).prepareAndResetIncrementThreeState;
    if (!runSetup) throw new Error("Ordered Increment 3 global setup is missing");
    const steps: string[] = [];

    await runSetup({
      async prepareDatabase() {
        steps.push("prepare");
      },
      async resetState() {
        steps.push("seed");
      },
    });

    expect(steps).toEqual(["prepare", "seed"]);
  });

  test("keeps destructive preparation out of Playwright config evaluation", () => {
    // Break caught: importing a derived config can reset the database after another setup phase.
    const config = (name: string) =>
      readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
    const base = config("playwright.config.ts");
    const disabled = config("playwright.increment-three-disabled.config.ts");
    const enabled = config("playwright.increment-three.config.ts");

    for (const source of [base, disabled, enabled]) {
      expect(source).not.toContain("await prepareIncrementThreeDatabase()");
    }
    expect(base).toContain(
      'globalSetup: "./tests/increment-three-database-global-setup.ts"',
    );
    expect(disabled).toContain(
      'globalSetup: "./tests/increment-three-global-setup.ts"',
    );
    expect(enabled).toContain(
      'globalSetup: "./tests/increment-three-global-setup.ts"',
    );
  });
});
