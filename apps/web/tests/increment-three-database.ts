import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { createDatabase } from "@pawket/database";
import { sql } from "drizzle-orm";

const defaultAdminUrl =
  "postgresql://pawket:pawket_task17_only@127.0.0.1:15437/pawket_task17";
const defaultTargetUrl =
  "postgresql://pawket:pawket_task17_only@127.0.0.1:15437/pawket_task17_browser";
const databaseNamePattern = /^pawket_[a-z0-9_]+$/u;
const browserDatabaseNamePattern = /^pawket_[a-z0-9_]+_browser$/u;

type BrowserDatabaseEnvironment = Readonly<Record<string, string | undefined>>;

export type IncrementThreeBrowserDatabaseConfiguration = Readonly<{
  adminUrl: string;
  targetUrl: string;
  adminDatabaseName: string;
  targetDatabaseName: string;
}>;

export type IncrementThreeBrowserResetSentinelPort = Readonly<{
  createSentinel(tableName: string, sentinelId: string): Promise<void>;
  resetTarget(targetDatabaseName: string): Promise<void>;
  hasSentinel(tableName: string, sentinelId: string): Promise<boolean>;
  dropSentinel(tableName: string): Promise<void>;
}>;

function unsafe(reason: string): never {
  throw new Error(`Unsafe Increment 3 browser database configuration: ${reason}`);
}

function parseDatabaseUrl(value: string, field: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    unsafe(`${field} must be a PostgreSQL URL`);
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    unsafe(`${field} must use PostgreSQL`);
  }
  if (
    (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") ||
    parsed.username.length === 0 ||
    parsed.password.length === 0 ||
    parsed.port.length === 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    unsafe(`${field} must be an explicit credentialed loopback target`);
  }
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  if (!databaseNamePattern.test(databaseName)) {
    unsafe(`${field} must name an isolated Pawket test database`);
  }
  return { parsed, databaseName };
}

export function resolveIncrementThreeBrowserDatabaseConfiguration(
  environment: BrowserDatabaseEnvironment = process.env,
): IncrementThreeBrowserDatabaseConfiguration {
  const adminUrl = environment.PAWKET_BROWSER_DATABASE_ADMIN_URL ?? defaultAdminUrl;
  const targetUrl = environment.PAWKET_BROWSER_DATABASE_URL ?? defaultTargetUrl;
  const admin = parseDatabaseUrl(adminUrl, "PAWKET_BROWSER_DATABASE_ADMIN_URL");
  const target = parseDatabaseUrl(targetUrl, "PAWKET_BROWSER_DATABASE_URL");
  if (!browserDatabaseNamePattern.test(target.databaseName)) {
    unsafe("PAWKET_BROWSER_DATABASE_URL must end in _browser");
  }
  if (admin.databaseName === target.databaseName) {
    unsafe("the sentinel and reset databases must differ");
  }
  if (
    admin.parsed.hostname !== target.parsed.hostname ||
    admin.parsed.port !== target.parsed.port ||
    admin.parsed.username !== target.parsed.username ||
    admin.parsed.password !== target.parsed.password
  ) {
    unsafe("the sentinel and reset databases must share one disposable server and role");
  }
  if (
    target.parsed.port === "5432" &&
    (environment.CI !== "true" ||
      environment.PAWKET_ALLOW_BROWSER_DATABASE_PORT_5432 !== "1")
  ) {
    unsafe("port 5432 requires the explicit CI-only guard");
  }
  return {
    adminUrl,
    targetUrl,
    adminDatabaseName: admin.databaseName,
    targetDatabaseName: target.databaseName,
  };
}

export const browserDatabaseConfiguration =
  resolveIncrementThreeBrowserDatabaseConfiguration();
export const browserDatabaseUrl = browserDatabaseConfiguration.targetUrl;

export function assertIncrementThreeBrowserDatabaseName(actual: unknown): void {
  if (actual !== browserDatabaseConfiguration.targetDatabaseName) {
    unsafe("the connected database is not the validated browser reset target");
  }
}

export async function resetIncrementThreeBrowserTargetWithSentinel(
  port: IncrementThreeBrowserResetSentinelPort,
  targetDatabaseName: string,
  entropy = randomUUID().replaceAll("-", ""),
): Promise<void> {
  if (
    !browserDatabaseNamePattern.test(targetDatabaseName) ||
    !/^[0-9a-f]{32}$/u.test(entropy)
  ) {
    unsafe("the browser reset sentinel inputs are invalid");
  }
  const tableName = `pawket_task17_reset_sentinel_${entropy}`;
  await port.createSentinel(tableName, entropy);
  try {
    await port.resetTarget(targetDatabaseName);
    if (!(await port.hasSentinel(tableName, entropy))) {
      throw new Error("Browser database admin sentinel was not preserved");
    }
  } finally {
    await port.dropSentinel(tableName);
  }
}

let preparedTargetUrl: string | undefined;

export async function prepareIncrementThreeDatabase() {
  const configuration = resolveIncrementThreeBrowserDatabaseConfiguration();
  if (preparedTargetUrl === configuration.targetUrl) return;
  const shared = createDatabase(configuration.adminUrl);
  try {
    const [connected] = await shared.db.execute<{ current_database: string }>(
      sql`select current_database() as current_database`,
    );
    if (connected?.current_database !== configuration.adminDatabaseName) {
      unsafe("the sentinel connection resolved to an unexpected database");
    }
    await resetIncrementThreeBrowserTargetWithSentinel(
      {
        async createSentinel(tableName, sentinelId) {
          await shared.db.execute(
            sql.raw(
              `create temporary table "${tableName}" (sentinel_id text primary key)`,
            ),
          );
          await shared.db.execute(
            sql.raw(
              `insert into "${tableName}" (sentinel_id) values ('${sentinelId}')`,
            ),
          );
        },
        async resetTarget(targetDatabaseName) {
          const quotedTarget = `"${targetDatabaseName}"`;
          await shared.db.execute(
            sql.raw(`drop database if exists ${quotedTarget} with (force)`),
          );
          await shared.db.execute(sql.raw(`create database ${quotedTarget}`));
        },
        async hasSentinel(tableName, sentinelId) {
          const [preserved] = await shared.db.execute<{ sentinel_id: string }>(
            sql.raw(
              `select sentinel_id from "${tableName}" where sentinel_id = '${sentinelId}'`,
            ),
          );
          return preserved?.sentinel_id === sentinelId;
        },
        async dropSentinel(tableName) {
          await shared.db.execute(sql.raw(`drop table if exists "${tableName}"`));
        },
      },
      configuration.targetDatabaseName,
    );
  } finally {
    await shared.close();
  }
  const workspaceRoot = path.resolve(import.meta.dirname, "../../..");
  execFileSync(
    process.execPath,
    [
      path.join(workspaceRoot, "node_modules/tsx/dist/cli.mjs"),
      path.join(workspaceRoot, "packages/database/src/migrate.ts"),
    ],
    {
      cwd: workspaceRoot,
      env: { ...process.env, DATABASE_URL: configuration.targetUrl },
      stdio: "inherit",
    },
  );
  preparedTargetUrl = configuration.targetUrl;
}
