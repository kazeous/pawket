import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as schema from "@pawket/database";
import { createEncryptionKeyring } from "@pawket/security";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export { schema };
export const commandIds = () => ({ idempotencyKey: randomUUID(), requestId: randomUUID() });
export function createResolutionIntegrationFixture(label: string) {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for resolution integration tests");
  const parsed = new URL(databaseUrl);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || !/test|ci/iu.test(parsed.pathname)) {
    throw new Error("Resolution integration tests require a dedicated local test database");
  }
  const schemaName = `resolution_${label}_${process.pid}_${Date.now()}`; const journalSchema = `${schemaName}_journal`;
  const client = postgres(databaseUrl, { max: 4, connection: { search_path: `${schemaName},public` }, onnotice: () => undefined });
  const db = drizzle(client, { schema });
  const lookupHmacKey = new Uint8Array(32).fill(57);
  const keyring = createEncryptionKeyring({ activeKeyId: "resolution-test", keys: { "resolution-test": lookupHmacKey } });
  return {
    client, db, keyring, lookupHmacKey,
    async initialize() {
      await client.unsafe(`create schema "${schemaName}"`);
      await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../database/migrations/", import.meta.url)), migrationsSchema: journalSchema });
    },
    async dispose() {
      await client.unsafe(`drop schema if exists "${schemaName}" cascade`);
      await client.unsafe(`drop schema if exists "${journalSchema}" cascade`);
      await client.end();
    },
    commandContext() {
      let clock = new Date("2026-10-07T04:00:00Z");
      const creator = { userId: `creator-${randomUUID()}`, sessionId: `session-${randomUUID()}` };
      const buyer = { userId: `buyer-${randomUUID()}`, sessionId: `session-${randomUUID()}` };
      const now = () => new Date(clock);
      return { orderId: randomUUID(), creator, buyer, now, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); },
        session: { getTipSessionAssurance: async () => ({ sessionExpiresAt: new Date(now().getTime() + 3_600_000) }) } };
    },
  };
}
