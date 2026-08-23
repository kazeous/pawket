import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.js";

export type PawketDatabase = PostgresJsDatabase<typeof schema>;

export function createDatabase(databaseUrl: string): {
  db: PawketDatabase;
  close(): Promise<void>;
} {
  const client = postgres(databaseUrl);

  return {
    db: drizzle(client, { schema }),
    close: () => client.end(),
  };
}
