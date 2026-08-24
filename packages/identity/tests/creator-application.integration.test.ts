import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { identityUsers } from "@pawket/database";
import { createEncryptionKeyring } from "@pawket/security";
import * as identity from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database integration tests");

type CreatorServiceFactory = {
  createCreatorApplicationService(input: unknown): {
    saveDraft(input: unknown): Promise<unknown>;
    submit(input: unknown): Promise<unknown>;
    withdraw(input: unknown): Promise<unknown>;
    getForApplicant(input: unknown): Promise<unknown>;
  };
};

const creatorExports = identity as unknown as Partial<CreatorServiceFactory>;
const schemaName = `creator_application_${process.pid}_${Date.now()}`;
const client = postgres(databaseUrl, { max: 1 });
const migrationsDirectory = new URL("../../database/migrations/", import.meta.url);
const db = drizzle(client);
const now = new Date("2026-08-24T03:00:00.000Z");
const keyring = createEncryptionKeyring({
  activeKeyId: "test-v1",
  keys: { "test-v1": Uint8Array.from({ length: 32 }, (_, index) => index + 1) },
});
const commandFingerprintKey = Uint8Array.from({ length: 32 }, (_, index) => index + 101);

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
  await db.insert(identityUsers).values({
    id: "creator-user",
    name: "Creator User",
    email: "creator@example.com",
    canonicalEmail: "creator@example.com",
    emailVerified: true,
    emailVerifiedAt: now,
    emailVerificationProvenance: "password_email_challenge",
    createdAt: now,
    updatedAt: now,
  });
});

afterAll(async () => {
  await client.unsafe("set search_path to public");
  await client.unsafe(`drop schema if exists "${schemaName}" cascade`);
  await client.end();
});

const completeDraft = {
  artistDisplayName: "Lan Artist",
  shortIntroduction: "Independent illustrator making gentle character art.",
  dateOfBirth: "2000-08-24",
  portfolioUrls: ["https://portfolio.example/lan"],
  primaryArtDiscipline: "illustration",
  practiceDescription: "I create digital illustration commissions and personal work.",
  contentIntent: "general_audience_only",
  proposedReceivingAccountId: "receiving-onboarding-opaque-1",
};

function service() {
  expect(typeof creatorExports.createCreatorApplicationService).toBe("function");
  return creatorExports.createCreatorApplicationService!({ db, keyring, commandFingerprintKey, idFactory: randomUUID, now: () => now });
}

describe("creator application repository", () => {
  test("persists an encrypted immutable submitted revision with versioned attestations", async () => {
    // Break caught: storing DOB plaintext, mutating a submitted revision, or submitting without all attestations.
    const applications = service();
    const draft = await applications.saveDraft({ userId: "creator-user", idempotencyKey: "draft-one", ...completeDraft });
    const submitted = await applications.submit({
      userId: "creator-user",
      idempotencyKey: "submit-one",
      expectedVersion: (draft as { version: number }).version,
      dateOfBirthAcknowledged: true,
      truthfulInformationAccepted: true,
      portfolioRightsAccepted: true,
      creatorTermsAccepted: true,
      privacyAccepted: true,
    });
    expect(submitted).toMatchObject({ state: "submitted", revision: { dateOfBirth: "2000-08-24" } });
    const stored = await client<{ dob_envelope: unknown; submitted_at: Date }[]>`
      select dob_envelope, submitted_at from creator_application_revisions where application_id = ${(submitted as { id: string }).id}
    `;
    expect(JSON.stringify(stored[0]?.dob_envelope)).not.toContain("2000-08-24");
    await expect(client.unsafe(`update creator_application_revisions set artist_display_name = 'changed' where application_id = '${(submitted as { id: string }).id}'`)).rejects.toThrow();
  });

  test("enforces expected versions and replays the same withdrawal idempotently", async () => {
    // Break caught: stale tabs changing state or duplicate commands generating duplicate state/events.
    const applications = service();
    const current = await applications.getForApplicant({ userId: "creator-user" }) as { version: number };
    await expect(applications.withdraw({ userId: "creator-user", idempotencyKey: "withdraw-one", expectedVersion: current.version - 1 })).rejects.toThrow();
    const withdrawn = await applications.withdraw({ userId: "creator-user", idempotencyKey: "withdraw-one", expectedVersion: current.version });
    await expect(applications.withdraw({ userId: "creator-user", idempotencyKey: "withdraw-one", expectedVersion: current.version })).resolves.toEqual(withdrawn);
  });

  test("forks a changes-requested submitted revision before the applicant resubmits", async () => {
    // Break caught: overwriting a reviewed immutable revision instead of preserving correction history.
    await db.insert(identityUsers).values({ id: "revision-user", name: "Revision User", email: "revision@example.com", canonicalEmail: "revision@example.com", emailVerified: true, emailVerifiedAt: now, emailVerificationProvenance: "password_email_challenge", createdAt: now, updatedAt: now });
    const applications = service();
    const draft = await applications.saveDraft({ userId: "revision-user", idempotencyKey: "revision-draft", ...completeDraft });
    const submitted = await applications.submit({ userId: "revision-user", idempotencyKey: "revision-submit", expectedVersion: (draft as { version:number }).version, dateOfBirthAcknowledged: true, truthfulInformationAccepted: true, portfolioRightsAccepted: true, creatorTermsAccepted: true, privacyAccepted: true }) as { id:string; version:number; revision:{id:string} };
    await client.unsafe(`update creator_applications set state = 'changes_requested', version = version + 1 where id = '${submitted.id}'`);
    const changed = await applications.saveDraft({ userId: "revision-user", idempotencyKey: "revision-change", expectedVersion: submitted.version + 1, ...completeDraft, shortIntroduction: "A corrected practice summary." }) as { version:number; revision:{id:string; revisionNumber:number; submittedAt:null} };
    expect(changed.revision).toMatchObject({ revisionNumber: 2, submittedAt: null });
    expect(changed.revision.id).not.toBe(submitted.revision.id);
    const resubmitted = await applications.submit({ userId: "revision-user", idempotencyKey: "revision-resubmit", expectedVersion: changed.version, dateOfBirthAcknowledged: true, truthfulInformationAccepted: true, portfolioRightsAccepted: true, creatorTermsAccepted: true, privacyAccepted: true });
    expect(resubmitted).toMatchObject({ state: "submitted", revision: { revisionNumber: 2 } });
  });
});
