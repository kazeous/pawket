import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as schema from "../src/schema.js";
import { createEncryptionKeyring, encryptSensitiveField } from "@pawket/security";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL required");
const parsed = new URL(databaseUrl);
if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || !/test|ci/iu.test(parsed.pathname)) {
  throw new Error("OIDC schema tests require a dedicated local test database");
}
const schemaName = `oidc_schema_${process.pid}_${Date.now()}`;
const journalSchema = `${schemaName}_journal`;
const client = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
const db = drizzle(client, { schema });
const migrationsFolder = fileURLToPath(new URL("../migrations/", import.meta.url));
const at = new Date("2026-09-27T10:00:00Z");
const later = new Date(at.getTime() + 300_000);
const keyring = createEncryptionKeyring({ activeKeyId: "oidc-test", keys: { "oidc-test": new Uint8Array(32).fill(13) } });
beforeAll(async () => {
  await client.unsafe(`create schema "${schemaName}"`);
  await client.unsafe(`set search_path to "${schemaName}", public`);
  await migrate(db, { migrationsFolder, migrationsSchema: journalSchema });
}, 30_000);
afterAll(async () => {
  await client.unsafe("set search_path to public");
  await client.unsafe(`drop schema if exists "${schemaName}" cascade`);
  await client.unsafe(`drop schema if exists "${journalSchema}" cascade`);
  await client.end();
});
async function user() {
  const id = randomUUID();
  await db.insert(schema.identityUsers).values({ id, email: `${id}@example.test`, canonicalEmail: `${id}@example.test`, name: "Fixture" });
  return id;
}
async function session(userId: string) {
  const id = randomUUID(); await db.insert(schema.identitySessions).values({ id, userId, token: `fixture-${id}`, expiresAt: later,
    createdAt: at, updatedAt: at, lastUsedAt: at, idleExpiresAt: later, absoluteExpiresAt: later }); return id;
}
function transaction() {
  const id = randomUUID(); return { id, stateHash: `fixture-${id}`, browserBindingHash: "fixture-browser-hash", nonce: "fixture-nonce",
    verifierEnvelope: encryptSensitiveField({ keyring, plaintext: "synthetic-verifier", binding: { recordType: "oidc_transaction", recordId: id, fieldName: "verifier" } }),
    purpose: "login", status: "pending", issuer: "https://idp.example/pawket/", clientId: "pawket-test", providerRevision: "pawket-v1",
    returnPath: "/settings/security", createdAt: at, expiresAt: later };
}
async function sqlState(operation: PromiseLike<unknown>, code: string) {
  try { await operation; throw new Error("invalid write was accepted"); }
  catch (error) { expect(error && typeof error === "object" && "cause" in error ? (error.cause as { code?: string })?.code : (error as { code?: string }).code).toBe(code); }
}

describe("OIDC persistence integrity", () => {
  test("owner proofs allow MFA and historical TOTP, but reject primary assurance", async () => {
    const userId = await user(); const sessionId = await session(userId);
    const proof = { userId, sessionId, actionClass: "owner.tip_policy_update", issuedAt: at, expiresAt: later };
    for (const assuranceMethod of ["mfa", "totp"]) {
      await db.insert(schema.identityStepUpProofs).values({ ...proof, assuranceMethod });
    }
    await expect(db.insert(schema.identityStepUpProofs).values({ ...proof, assuranceMethod: "primary" }))
      .rejects.toMatchObject({ cause: { code: "23514", constraint_name: "identity_step_up_proofs_owner_totp_check" } });
  });
  test("second-factor columns are renamed without retaining the old names", async () => {
    const rows = await client<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
      where table_schema = ${schemaName} and table_name in
        ('identity_oidc_sessions', 'payment_confirmations', 'payments_sepay_account_cutovers')`;
    const names = rows.map((row) => `${row.table_name}.${row.column_name}`);
    expect(names).toContain("identity_oidc_sessions.mfa_status");
    expect(names).toContain("payment_confirmations.mfa_verified_at");
    expect(names).toContain("payments_sepay_account_cutovers.mfa_verified_at");
    expect(names).not.toContain("identity_oidc_sessions.totp_status");
    expect(names).not.toContain("payment_confirmations.totp_verified_at");
    expect(names).not.toContain("payments_sepay_account_cutovers.totp_verified_at");
  });
  test("migrations are repeatable with no cross-schema FKs", async () => {
    await migrate(db, { migrationsFolder, migrationsSchema: journalSchema });
    const rows = await client`select distinct target_ns.nspname from pg_constraint c join pg_class source on source.oid = c.conrelid join pg_namespace source_ns on source_ns.oid = source.relnamespace join pg_class target on target.oid = c.confrelid join pg_namespace target_ns on target_ns.oid = target.relnamespace where c.contype = 'f' and source_ns.nspname = ${schemaName}`;
    expect(rows).toEqual([{ nspname: schemaName }]);
  });
  test("allows authentik identity but preserves issuer/subject uniqueness and no provider tokens/passwords", async () => {
    const userId = await user();
    const account = { id: randomUUID(), userId, issuer: "https://idp.example/pawket/", providerId: "authentik", accountId: randomUUID() };
    await db.insert(schema.identityAccounts).values(account);
    await sqlState(db.insert(schema.identityAccounts).values({ ...account, id: randomUUID() }), "23505");
    await sqlState(db.insert(schema.identityAccounts).values({ ...account, id: randomUUID(), accountId: randomUUID(), accessToken: "forbidden" }), "23514");
    await sqlState(db.insert(schema.identityAccounts).values({ ...account, id: randomUUID(), accountId: randomUUID(), password: "forbidden", passwordHashVersion: 1 }), "23514");
  });
  test("transactions require encrypted verifier and actor/session consistency", async () => {
    const t = transaction(); await db.insert(schema.identityOidcTransactions).values(t);
    await sqlState(db.insert(schema.identityOidcTransactions).values({ ...transaction(), verifierEnvelope: { plaintext: "forbidden" } as never }), "23514");
    await sqlState(db.insert(schema.identityOidcTransactions).values({ ...transaction(), purpose: "step_up", actionClass: "owner.change", commandDigest: "digest" }), "23514");
    const first = await user(); const second = await user(); const sessionId = await session(first);
    await sqlState(db.insert(schema.identityOidcTransactions).values({ ...transaction(), purpose: "lease_check", expectedUserId: second,
      expectedSessionId: sessionId, expectedSubject: "subject", expectedAuthorizationVersion: 1 }), "23503");
    await sqlState(db.insert(schema.identityOidcTransactions).values({ ...transaction(), expiresAt: new Date(at.getTime() + 601_000) }), "23514");
  });
  test("OIDC sidecars cannot attach another user's account or extend the five-minute lease", async () => {
    const first = await user(); const second = await user(); const sessionId = await session(first);
    const accountId = randomUUID(); await db.insert(schema.identityAccounts).values({ id: accountId, userId: second, issuer: "https://idp.example/pawket/", providerId: "authentik", accountId: second });
    const t = transaction(); await db.insert(schema.identityOidcTransactions).values(t);
    const sidecar = { sessionId, userId: first, accountId, clientId: "pawket-test", providerRevision: "pawket-v1", sid: "sid",
      primaryMethod: "password", mfaStatus: "not_enrolled", evidenceVerifiedAt: at, leaseStartedAt: at, idpValidUntil: later, transactionId: t.id };
    await sqlState(db.insert(schema.identityOidcSessions).values(sidecar), "23503");
    await db.update(schema.identityAccounts).set({ userId: first }).where(eq(schema.identityAccounts.id, accountId));
    await sqlState(db.insert(schema.identityOidcSessions).values({ ...sidecar, idpValidUntil: new Date(at.getTime() + 301_000) }), "23514");
    await db.insert(schema.identityOidcSessions).values(sidecar);
  });
});
