import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  creatorApplicationRevisions,
  creatorApplications,
  identityCreatorCapabilities,
  identityUsers,
  type PawketDatabase,
} from "@pawket/database";
import { createIdentityCreatorSeedPort } from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for identity integration tests");

const schemaName = `identity_creator_catalog_port_${process.pid}_${Date.now()}`;
const client = postgres(databaseUrl, { max: 1 });
const db = drizzle(client) as PawketDatabase;
const migrationsDirectory = new URL("../../database/migrations/", import.meta.url);

async function migrate(filename: string): Promise<void> {
  const migration = await readFile(new URL(filename, migrationsDirectory), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.unsafe(statement);
  }
}

beforeAll(async () => {
  await client.unsafe(`create schema "${schemaName}"`);
  await client.unsafe(`set search_path to "${schemaName}", public`);
  for (const migration of (await readdir(migrationsDirectory)).filter((entry) => entry.endsWith(".sql")).sort()) {
    await migrate(migration);
  }
});

afterAll(async () => {
  await client.unsafe("set search_path to public");
  await client.unsafe(`drop schema if exists "${schemaName}" cascade`);
  await client.end();
});

describe("Identity creator catalog seed port", () => {
  test("projects only approved public creator seed fields", async () => {
    // Break caught: Catalog obtaining a whole application revision or any applicant/payment/review data.
    const userId = `catalog-seed-user-${randomUUID()}`;
    const applicationId = randomUUID();
    const revisionId = randomUUID();
    const at = new Date("2026-08-29T03:00:00.000Z");
    await db.insert(identityUsers).values({
      id: userId,
      name: "Catalog Seed Artist",
      email: "catalog-seed@example.test",
      canonicalEmail: "catalog-seed@example.test",
      emailVerified: true,
      emailVerifiedAt: at,
      emailVerificationProvenance: "password_email_challenge",
      createdAt: at,
      updatedAt: at,
    });
    await db.insert(creatorApplications).values({
      id: applicationId,
      userId,
      state: "approved",
      version: 3,
      currentRevisionId: revisionId,
      createdAt: at,
      updatedAt: at,
    });
    await db.insert(creatorApplicationRevisions).values({
      id: revisionId,
      applicationId,
      revisionNumber: 1,
      artistDisplayName: "Seed Artist",
      shortIntroduction: "A safe public introduction.",
      applicantEmail: "private-applicant@example.test",
      portfolioUrls: ["https://portfolio.example.test/private"],
      proposedReceivingAccountId: "receiving-account-private-reference",
      createdAt: at,
      updatedAt: at,
    });
    await db.insert(identityCreatorCapabilities).values({
      id: randomUUID(),
      userId,
      state: "active",
      version: 7,
      approvedApplicationId: applicationId,
      approvedRevisionId: revisionId,
      suspendedAt: null,
      createdAt: at,
      updatedAt: at,
    });

    const port = createIdentityCreatorSeedPort();
    const seed = await port.getCreatorSeed(db, userId);

    expect(seed).toEqual({
      userId,
      capabilityState: "active",
      capabilityVersion: 7,
      approvedRevisionId: revisionId,
      displayName: "Seed Artist",
      introduction: "A safe public introduction.",
    });
    expect(Object.keys(seed ?? {}).sort()).toEqual([
      "approvedRevisionId",
      "capabilityState",
      "capabilityVersion",
      "displayName",
      "introduction",
      "userId",
    ]);
    expect(JSON.stringify(seed)).not.toContain("applicantEmail");
    expect(JSON.stringify(seed)).not.toContain("portfolio");
    expect(JSON.stringify(seed)).not.toContain("receiving");
    const batchPort = port as typeof port & { getCreatorSeeds?: (database: PawketDatabase, userIds: readonly string[]) => Promise<ReadonlyMap<string, typeof seed>> };
    expect(typeof batchPort.getCreatorSeeds).toBe("function");
    const seeds = await batchPort.getCreatorSeeds!(db, [userId, "not-a-creator"]);
    expect([...seeds.entries()]).toEqual([
      [userId, { userId, capabilityState: "active", capabilityVersion: 7, approvedRevisionId: revisionId, displayName: "Seed Artist", introduction: "A safe public introduction." }],
      ["not-a-creator", null],
    ]);
  });

  test("returns null when the user has no authoritative creator capability", async () => {
    // Break caught: initializing a catalog page from an application or user record without a capability grant.
    await expect(createIdentityCreatorSeedPort().getCreatorSeed(db, "not-a-creator")).resolves.toBeNull();
  });

  test("returns null when the approved revision belongs to a different application", async () => {
    // Break caught: projecting a stale or mismatched revision that does not belong to the capability's approved application.
    const userId = `mismatched-application-user-${randomUUID()}`;
    const approvedApplicationId = randomUUID();
    const approvedRevisionId = randomUUID();
    const staleApplicationId = randomUUID();
    const staleRevisionId = randomUUID();
    const at = new Date("2026-08-29T03:00:00.000Z");
    await db.insert(identityUsers).values({
      id: userId,
      name: "Mismatched Application Artist",
      email: "mismatched-application@example.test",
      canonicalEmail: "mismatched-application@example.test",
      emailVerified: true,
      emailVerifiedAt: at,
      emailVerificationProvenance: "password_email_challenge",
      createdAt: at,
      updatedAt: at,
    });
    await db.insert(creatorApplications).values([
      { id: approvedApplicationId, userId, state: "approved", version: 1, currentRevisionId: approvedRevisionId, createdAt: at, updatedAt: at },
      { id: staleApplicationId, userId, state: "approved", version: 1, currentRevisionId: staleRevisionId, createdAt: at, updatedAt: at },
    ]);
    await db.insert(creatorApplicationRevisions).values([
      { id: approvedRevisionId, applicationId: approvedApplicationId, revisionNumber: 1, artistDisplayName: "Approved Artist", shortIntroduction: "The approved profile.", createdAt: at, updatedAt: at },
      { id: staleRevisionId, applicationId: staleApplicationId, revisionNumber: 1, artistDisplayName: "Stale Artist", shortIntroduction: "A profile from another application.", createdAt: at, updatedAt: at },
    ]);
    await db.insert(identityCreatorCapabilities).values({
      id: randomUUID(), userId, state: "active", version: 1,
      approvedApplicationId, approvedRevisionId: staleRevisionId, suspendedAt: null, createdAt: at, updatedAt: at,
    });

    await expect(createIdentityCreatorSeedPort().getCreatorSeed(db, userId)).resolves.toBeNull();
  });

  test("returns a suspended capability's exact six-field seed", async () => {
    // Break caught: hiding suspended capability state instead of letting the later private remediation flow decide it.
    const userId = `suspended-catalog-seed-user-${randomUUID()}`;
    const applicationId = randomUUID();
    const revisionId = randomUUID();
    const at = new Date("2026-08-29T03:00:00.000Z");
    await db.insert(identityUsers).values({
      id: userId, name: "Suspended Catalog Artist", email: "suspended-catalog@example.test",
      canonicalEmail: "suspended-catalog@example.test", emailVerified: true, emailVerifiedAt: at,
      emailVerificationProvenance: "password_email_challenge", createdAt: at, updatedAt: at,
    });
    await db.insert(creatorApplications).values({
      id: applicationId, userId, state: "approved", version: 2, currentRevisionId: revisionId, createdAt: at, updatedAt: at,
    });
    await db.insert(creatorApplicationRevisions).values({
      id: revisionId, applicationId, revisionNumber: 1, artistDisplayName: "Suspended Artist",
      shortIntroduction: "A public seed awaiting private remediation.", createdAt: at, updatedAt: at,
    });
    await db.insert(identityCreatorCapabilities).values({
      id: randomUUID(), userId, state: "suspended", version: 4, approvedApplicationId: applicationId,
      approvedRevisionId: revisionId, suspendedAt: at, createdAt: at, updatedAt: at,
    });

    await expect(createIdentityCreatorSeedPort().getCreatorSeed(db, userId)).resolves.toEqual({
      userId,
      capabilityState: "suspended",
      capabilityVersion: 4,
      approvedRevisionId: revisionId,
      displayName: "Suspended Artist",
      introduction: "A public seed awaiting private remediation.",
    });
  });
});
