import postgres from "postgres";

export async function checkDatabaseReadiness(databaseUrl: string): Promise<void> {
  const client = postgres(databaseUrl, { max: 1 });

  try {
    await client.unsafe("SELECT 1");
  } finally {
    await client.end();
  }
}
