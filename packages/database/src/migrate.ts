import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to run database migrations");
}

const client = postgres(databaseUrl, { max: 1 });

try {
  await migrate(drizzle(client), { migrationsFolder: "migrations" });
} finally {
  await client.end();
}
