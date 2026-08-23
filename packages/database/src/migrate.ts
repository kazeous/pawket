import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to run database migrations");
}

const client = postgres(databaseUrl, { max: 1 });
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

try {
  await migrate(drizzle(client), { migrationsFolder });
} finally {
  await client.end();
}
