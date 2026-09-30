import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "@pawket/database";

export function oidcTestDatabase() {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL required");
  const parsed = new URL(databaseUrl);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || !/test|ci/iu.test(parsed.pathname)) {
    throw new Error("OIDC integration tests require a dedicated local test database");
  }
  const schemaName = `oidc_${randomUUID().replaceAll("-", "")}`;
  const journal = `${schemaName}_journal`;
  const client = postgres(databaseUrl, { max: 6, onnotice: () => undefined, connection: { search_path: `${schemaName}, public` } });
  const db = drizzle(client, { schema }) as unknown as schema.PawketDatabase;
  return {
    db, client,
    async setup() {
      await client.unsafe(`create schema "${schemaName}"`);
      await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../database/migrations/", import.meta.url)), migrationsSchema: journal });
    },
    async close() {
      await client.unsafe(`drop schema if exists "${schemaName}" cascade`);
      await client.unsafe(`drop schema if exists "${journal}" cascade`);
      await client.end();
    },
  };
}
