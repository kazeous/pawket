import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "@pawket/database";
import { identityUsers } from "@pawket/database";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { insertTestPenalty, penaltyAt, seedPenaltySubject } from "./penalty-test-fixture.js";
import { activePenalties, createTrustRestrictionPort } from "../src/penalty-port.js";
import { createEncryptionKeyring, encryptSensitiveField } from "@pawket/security";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL required");
const parsed = new URL(databaseUrl);
if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || !/test|ci/iu.test(parsed.pathname)) {
  throw new Error("Penalty integration tests require a dedicated local test database");
}
const schemaName = `penalty_${randomUUID().replaceAll("-", "")}`; const journal = `${schemaName}_journal`;
const client = postgres(databaseUrl, { max: 4, onnotice: () => undefined, connection: { search_path: `${schemaName}, public` } });
const db = drizzle(client, { schema });
beforeAll(async () => {
  await client.unsafe(`create schema "${schemaName}"`);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../database/migrations/", import.meta.url)), migrationsSchema: journal });
}, 30_000);
afterAll(async () => {
  await client.unsafe(`drop schema if exists "${schemaName}" cascade`);
  await client.unsafe(`drop schema if exists "${journal}" cascade`); await client.end();
});
const enabled = createTrustRestrictionPort({ mode: "enabled" });
describe("trust restriction commit fence", () => {
  test("assertAllowed throws restricted inside the window and passes after ends_at", async () => {
    const subject = await seedPenaltySubject(client);
    const id = await insertTestPenalty(client, subject, { kind: "restriction" });
    const check = (at: Date, restriction: "reporting" | "commission_buying" = "reporting") => db.transaction((tx) => enabled.assertAllowed(tx, { userId: subject.userId, restriction, at }));
    await expect(check(new Date("2026-10-09T23:59Z"))).resolves.toBeUndefined();
    await expect(check(penaltyAt)).rejects.toMatchObject({ name: "TrustEnforcementError", code: "restricted" });
    await expect(check(new Date("2026-10-10T12:00Z"))).rejects.toMatchObject({ code: "restricted" });
    await expect(check(new Date("2026-10-11T00:00Z"))).resolves.toBeUndefined();
    await expect(check(penaltyAt, "commission_buying")).resolves.toBeUndefined();
    expect((await db.transaction((tx) => activePenalties(tx, subject.userId, penaltyAt))).map((row) => row.id)).toEqual([id]);
    await client`update trust_penalties set state = 'lifted', ended_at = '2026-10-10T01:00Z', version = version + 1 where id = ${id}`;
    await expect(check(penaltyAt)).resolves.toBeUndefined();
  });
  test("disabled mode never throws", async () => {
    const subject = await seedPenaltySubject(client); await insertTestPenalty(client, subject, { kind: "restriction" });
    await expect(db.transaction((tx) => createTrustRestrictionPort({ mode: "disabled" }).assertAllowed(tx, {
      userId: subject.userId, restriction: "reporting", at: penaltyAt,
    }))).resolves.toBeUndefined();
  });
  test("assertAllowed waits for a concurrent writer holding the user row FOR UPDATE", async () => {
    const subject = await seedPenaltySubject(client); const held = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const penaltyId = randomUUID(); const envelope = encryptSensitiveField({ keyring: createEncryptionKeyring({ activeKeyId: "schema-tests", keys: { "schema-tests": new Uint8Array(32).fill(73) } }),
      plaintext: "Synthetic restriction", binding: { recordType: "trust_penalties", recordId: penaltyId, fieldName: "explanation" } });
    const writer = db.transaction(async (tx) => {
      await tx.select().from(identityUsers).where(eq(identityUsers.id, subject.userId)).for("update");
      await tx.execute(sql`insert into trust_penalties (id, subject_user_id, kind, restriction, state, reason_category,
        explanation_envelope, source_case_id, starts_at, owner_user_id, owner_session_id, step_up_proof_id, request_id, created_at)
        values (${penaltyId}, ${subject.userId}, 'restriction', 'reporting', 'active', 'other', ${JSON.stringify(envelope)}::jsonb,
          ${subject.sourceCaseId}, ${penaltyAt.toISOString()}, ${subject.ownerUserId}, 'owner-session', ${subject.actor.stepUpProofId}, 'writer', ${penaltyAt.toISOString()})`);
      held.resolve(); await release.promise;
    });
    await Promise.race([held.promise, writer]); let settled = false;
    const checker = db.transaction((tx) => enabled.assertAllowed(tx, { userId: subject.userId, restriction: "reporting", at: penaltyAt }))
      .then(() => { settled = true; return null; }, (error: unknown) => { settled = true; return error; });
    try { await new Promise((resolve) => setTimeout(resolve, 200)); expect(settled).toBe(false); }
    finally { release.resolve(); await writer; }
    expect(await checker).toMatchObject({ code: "restricted" });
  });
});
