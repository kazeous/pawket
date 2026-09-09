import { describe, expect, test } from "vitest";

import * as databaseHarness from "./increment-three-database";

type BrowserDatabaseEnvironment = Readonly<Record<string, string | undefined>>;
type BrowserDatabaseConfiguration = Readonly<{
  adminUrl: string;
  targetUrl: string;
  adminDatabaseName: string;
  targetDatabaseName: string;
}>;

const resolveConfiguration = (
  environment: BrowserDatabaseEnvironment,
): BrowserDatabaseConfiguration => {
  const resolver = (
    databaseHarness as unknown as {
      resolveIncrementThreeBrowserDatabaseConfiguration?: (
        input: BrowserDatabaseEnvironment,
      ) => BrowserDatabaseConfiguration;
    }
  ).resolveIncrementThreeBrowserDatabaseConfiguration;
  if (!resolver) throw new Error("Increment 3 browser database resolver is missing");
  return resolver(environment);
};

describe("Increment 3 browser database isolation", () => {
  test("defaults to the dedicated Task 17 loopback server and browser-only database", () => {
    // Break caught: a local browser run silently targets the unrelated PostgreSQL service on port 5432.
    expect(resolveConfiguration({})).toEqual({
      adminUrl:
        "postgresql://pawket:pawket_task17_only@127.0.0.1:15437/pawket_task17",
      targetUrl:
        "postgresql://pawket:pawket_task17_only@127.0.0.1:15437/pawket_task17_browser",
      adminDatabaseName: "pawket_task17",
      targetDatabaseName: "pawket_task17_browser",
    });
  });

  test("accepts an explicitly guarded synthetic CI database on port 5432", () => {
    // Break caught: CI cannot redirect destructive browser setup to its disposable PostgreSQL service.
    expect(
      resolveConfiguration({
        CI: "true",
        PAWKET_ALLOW_BROWSER_DATABASE_PORT_5432: "1",
        PAWKET_BROWSER_DATABASE_ADMIN_URL:
          "postgresql://pawket:pawket_ci_only@127.0.0.1:5432/pawket_ci",
        PAWKET_BROWSER_DATABASE_URL:
          "postgresql://pawket:pawket_ci_only@127.0.0.1:5432/pawket_ci_browser",
      }),
    ).toMatchObject({
      adminDatabaseName: "pawket_ci",
      targetDatabaseName: "pawket_ci_browser",
    });
  });

  test.each([
    {
      label: "an unrelated local port 5432",
      environment: {
        PAWKET_BROWSER_DATABASE_ADMIN_URL:
          "postgresql://pawket:synthetic@127.0.0.1:5432/pawket_test",
        PAWKET_BROWSER_DATABASE_URL:
          "postgresql://pawket:synthetic@127.0.0.1:5432/pawket_test_browser",
      },
    },
    {
      label: "a non-loopback server",
      environment: {
        PAWKET_BROWSER_DATABASE_ADMIN_URL:
          "postgresql://pawket:synthetic@db.example.test:15437/pawket_test",
        PAWKET_BROWSER_DATABASE_URL:
          "postgresql://pawket:synthetic@db.example.test:15437/pawket_test_browser",
      },
    },
    {
      label: "a target without a browser-only suffix",
      environment: {
        PAWKET_BROWSER_DATABASE_ADMIN_URL:
          "postgresql://pawket:synthetic@127.0.0.1:15437/postgres",
        PAWKET_BROWSER_DATABASE_URL:
          "postgresql://pawket:synthetic@127.0.0.1:15437/pawket_shared",
      },
    },
    {
      label: "a target on a different server from its sentinel database",
      environment: {
        PAWKET_BROWSER_DATABASE_ADMIN_URL:
          "postgresql://pawket:synthetic@127.0.0.1:15437/pawket_test",
        PAWKET_BROWSER_DATABASE_URL:
          "postgresql://pawket:synthetic@localhost:15438/pawket_test_browser",
      },
    },
  ])("rejects $label before reset", ({ environment }) => {
    // Break caught: validation permits a destructive reset outside the isolated synthetic target.
    expect(() => resolveConfiguration(environment)).toThrow(
      "Unsafe Increment 3 browser database configuration",
    );
  });

  test("proves admin preservation without requiring any Pawket application table", async () => {
    // Break caught: browser reset uses identity_users as its sentinel and fails on a clean admin database.
    const reset = (
      databaseHarness as unknown as {
        resetIncrementThreeBrowserTargetWithSentinel?: (
          port: {
            createSentinel(tableName: string, sentinelId: string): Promise<void>;
            resetTarget(targetDatabaseName: string): Promise<void>;
            hasSentinel(tableName: string, sentinelId: string): Promise<boolean>;
            dropSentinel(tableName: string): Promise<void>;
          },
          targetDatabaseName: string,
          entropy: string,
        ) => Promise<void>;
      }
    ).resetIncrementThreeBrowserTargetWithSentinel;
    if (!reset) throw new Error("Schema-independent browser reset sentinel is missing");
    const calls: string[] = [];
    const entropy = "0123456789abcdef0123456789abcdef";

    await reset(
      {
        async createSentinel(tableName, sentinelId) {
          calls.push(`create:${tableName}:${sentinelId}`);
        },
        async resetTarget(targetDatabaseName) {
          calls.push(`reset:${targetDatabaseName}`);
        },
        async hasSentinel(tableName, sentinelId) {
          calls.push(`verify:${tableName}:${sentinelId}`);
          return true;
        },
        async dropSentinel(tableName) {
          calls.push(`drop:${tableName}`);
        },
      },
      "pawket_task17_browser",
      entropy,
    );

    const tableName = `pawket_task17_reset_sentinel_${entropy}`;
    expect(calls).toEqual([
      `create:${tableName}:${entropy}`,
      "reset:pawket_task17_browser",
      `verify:${tableName}:${entropy}`,
      `drop:${tableName}`,
    ]);
  });

  test("drops the admin-only sentinel when target reset fails", async () => {
    // Break caught: a failed browser reset leaves even its internal admin sentinel behind.
    const reset = databaseHarness.resetIncrementThreeBrowserTargetWithSentinel;
    const dropSentinel = async () => undefined;
    const dropped: string[] = [];

    await expect(
      reset(
        {
          async createSentinel() {},
          async resetTarget() {
            throw new Error("synthetic reset failure");
          },
          async hasSentinel() {
            return false;
          },
          async dropSentinel(tableName) {
            await dropSentinel();
            dropped.push(tableName);
          },
        },
        "pawket_task17_browser",
        "fedcba9876543210fedcba9876543210",
      ),
    ).rejects.toThrow("synthetic reset failure");
    expect(dropped).toEqual([
      "pawket_task17_reset_sentinel_fedcba9876543210fedcba9876543210",
    ]);
  });
});
