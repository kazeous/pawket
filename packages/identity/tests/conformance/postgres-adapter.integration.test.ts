import { readFile } from "node:fs/promises";

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { convertSetCookieToCookie } from "better-auth/test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { hashPassword, verifyPassword } from "../../src/auth-candidate/password.js";
import {
  createPawketAuthAdapter,
  hashSessionToken,
} from "../../src/auth-candidate/session-token-adapter.js";
import * as schema from "./generated/auth-schema.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for auth conformance integration tests");

const client = postgres(databaseUrl, { max: 1 });
const db = drizzle(client, { schema });
const auth = betterAuth({
  appName: "Pawket",
  baseURL: "http://localhost:3000",
  secret: "postgres-conformance-secret-at-least-32-characters",
  database: createPawketAuthAdapter(
    drizzleAdapter(db, { provider: "pg", schema, transaction: true }),
  ),
  user: { modelName: "identityUsers" },
  session: { modelName: "identitySessions", cookieCache: { enabled: false } },
  account: {
    modelName: "identityAccounts",
    accountLinking: { disableImplicitLinking: true, allowDifferentEmails: false },
  },
  verification: { modelName: "identityVerifications", storeIdentifier: "hashed" },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    minPasswordLength: 15,
    maxPasswordLength: 128,
    password: { hash: hashPassword, verify: verifyPassword },
  },
});

const tableNames = [
  "identity_two_factors",
  "identity_verifications",
  "identity_accounts",
  "identity_sessions",
  "identity_users",
] as const;

async function dropCandidateTables() {
  for (const table of tableNames) await client.unsafe(`drop table if exists ${table} cascade`);
}

beforeAll(async () => {
  await dropCandidateTables();
  const migration = await readFile(
    new URL("./migrations/0000_auth-candidate.sql", import.meta.url),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.unsafe(statement);
  }
});

afterAll(async () => {
  await dropCandidateTables();
  await client.end();
});

describe("Better Auth Drizzle/PostgreSQL conformance", () => {
  test("the generated migration and wrapped adapter keep the raw session out of PostgreSQL", async () => {
    const response = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify({
          email: "postgres-artist@example.com",
          name: "Postgres Artist",
          password: "postgres password long enough",
        }),
      }),
    );
    const payload = (await response.json()) as { token: string };
    const rows = await client<{ token: string }[]>`select token from identity_sessions`;

    expect(response.status).toBe(200);
    expect(rows).toEqual([{ token: hashSessionToken(payload.token) }]);
    expect(JSON.stringify(rows)).not.toContain(payload.token);

    const cookieHeaders = convertSetCookieToCookie(response.headers);
    await expect(auth.api.getSession({ headers: cookieHeaders })).resolves.toEqual(
      expect.objectContaining({ user: expect.objectContaining({ email: "postgres-artist@example.com" }) }),
    );
    await auth.api.revokeSessions({ headers: cookieHeaders });
    await expect(auth.api.getSession({ headers: cookieHeaders })).resolves.toBeNull();
  });
});
