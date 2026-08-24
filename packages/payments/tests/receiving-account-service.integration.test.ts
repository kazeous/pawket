import { readdir, readFile } from "node:fs/promises";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { identityUsers } from "@pawket/database";
import {
  createEncryptionKeyring,
  decryptSensitiveField,
  type EncryptionEnvelope,
} from "@pawket/security";
import * as payments from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for payments integration tests");

type AccountProjection = {
  referenceId: string;
  onboardingId: string;
  version: number;
  bankBin: string;
  bankName: string;
  maskedSuffix: string;
  proofState: string;
};

type ReceivingAccountService = {
  propose(input: {
    applicantUserId: string;
    sessionId: string;
    primaryAuthenticatedAt: Date;
    idempotencyKey: string;
    bankBin: string;
    accountNumber: string;
    accountHolderLabel: string;
  }): Promise<AccountProjection>;
};

type PaymentsExports = {
  createReceivingAccountService(input: unknown): ReceivingAccountService;
  createCreatorReceivingAccountReferenceValidator(input: { db: unknown }): {
    isValidForApplicant(input: {
      applicantUserId: string;
      reference: string;
    }): Promise<boolean>;
  };
};

type StoredAccount = {
  id: string;
  onboarding_id: string;
  version: number;
  account_number_envelope: EncryptionEnvelope;
  account_holder_label_envelope: EncryptionEnvelope;
  account_fingerprint: string;
  masked_suffix: string;
  retired_at: Date | string | null;
};

const api = payments as unknown as Partial<PaymentsExports>;
const schemaName = `payments_receiving_account_${process.pid}_${Date.now()}`;
const client = postgres(databaseUrl, { max: 1 });
const db = drizzle(client);
const migrationsDirectory = new URL("../../database/migrations/", import.meta.url);
const now = new Date("2026-08-25T02:00:00.000Z");
const keyring = createEncryptionKeyring({
  activeKeyId: "payments-test-v1",
  keys: { "payments-test-v1": new Uint8Array(32).fill(11) },
});
const lookupHmacKey = new Uint8Array(32).fill(17);
const supportedBanks = { "970415": "VietinBank", "970436": "Vietcombank" } as const;

async function migrate(filename: string): Promise<void> {
  const migration = await readFile(new URL(filename, migrationsDirectory), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.unsafe(statement);
  }
}

beforeAll(async () => {
  await client.unsafe(`create schema "${schemaName}"`);
  await client.unsafe(`set search_path to "${schemaName}", public`);
  for (const migration of (await readdir(migrationsDirectory))
    .filter((entry) => entry.endsWith(".sql"))
    .sort()) {
    await migrate(migration);
  }
  await db.insert(identityUsers).values([
    {
      id: "payments-applicant",
      name: "Payments Applicant",
      email: "payments@example.com",
      canonicalEmail: "payments@example.com",
      emailVerified: true,
      emailVerifiedAt: now,
      emailVerificationProvenance: "password_email_challenge",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "other-applicant",
      name: "Other Applicant",
      email: "other-payments@example.com",
      canonicalEmail: "other-payments@example.com",
      emailVerified: true,
      emailVerifiedAt: now,
      emailVerificationProvenance: "password_email_challenge",
      createdAt: now,
      updatedAt: now,
    },
  ]);
});

afterAll(async () => {
  await client.unsafe("set search_path to public");
  await client.unsafe(`drop schema if exists "${schemaName}" cascade`);
  await client.end();
});

function service(): ReceivingAccountService {
  expect(typeof api.createReceivingAccountService).toBe("function");
  return api.createReceivingAccountService!({
    db,
    keyring,
    lookupHmacKey,
    supportedBanks,
    now: () => now,
  });
}

const firstProposal = {
  applicantUserId: "payments-applicant",
  sessionId: "applicant-session",
  primaryAuthenticatedAt: new Date(now.getTime() - 60_000),
  idempotencyKey: "receiving-account-one",
  bankBin: "970436",
  accountNumber: "001234567890",
  accountHolderLabel: "NGUYEN VAN A",
};

describe("receiving-account service", () => {
  test("requires recent authentication and persists only encrypted account fields", async () => {
    // Break caught: accepting stale authentication, exposing raw bank fields, or storing them outside bound encryption envelopes.
    const accounts = service();
    await expect(
      accounts.propose({
        ...firstProposal,
        idempotencyKey: "stale-receiving-account",
        primaryAuthenticatedAt: new Date(now.getTime() - 15 * 60_000 - 1),
      }),
    ).rejects.toThrow("Recent authentication required");

    const created = await accounts.propose(firstProposal);
    expect(created).toMatchObject({
      version: 1,
      bankBin: "970436",
      bankName: "Vietcombank",
      maskedSuffix: "•••• 7890",
      proofState: "unverified",
    });
    expect(JSON.stringify(created)).not.toContain("001234567890");
    expect(JSON.stringify(created)).not.toContain("NGUYEN VAN A");

    const [stored] = await client<StoredAccount[]>`
      select id, onboarding_id, version, account_number_envelope,
             account_holder_label_envelope, account_fingerprint, masked_suffix, retired_at
      from payments_receiving_account_onboarding
      where id = ${created.referenceId}
    `;
    expect(stored?.account_fingerprint).toMatch(/^hmac-sha256:v1:/u);
    expect(JSON.stringify(stored)).not.toContain("001234567890");
    expect(JSON.stringify(stored)).not.toContain("NGUYEN VAN A");
    expect(
      decryptSensitiveField({
        envelope: stored!.account_number_envelope,
        binding: {
          recordType: "payments_receiving_account",
          recordId: stored!.id,
          fieldName: "account_number",
        },
        keyring,
      }),
    ).toBe("001234567890");
    expect(
      decryptSensitiveField({
        envelope: stored!.account_holder_label_envelope,
        binding: {
          recordType: "payments_receiving_account",
          recordId: stored!.id,
          fieldName: "account_holder_label",
        },
        keyring,
      }),
    ).toBe("NGUYEN VAN A");

    await expect(accounts.propose(firstProposal)).resolves.toEqual(created);
    const countRows = await client<{ count: number }[]>`
      select count(*)::int as count from payments_receiving_account_onboarding
      where applicant_user_id = 'payments-applicant'
    `;
    expect(countRows[0]?.count).toBe(1);
  });

  test("creates an immutable new version and validates only the applicant's current reference", async () => {
    // Break caught: overwriting bank ciphertext in place or accepting another applicant's/retired opaque reference.
    const accounts = service();
    const first = await accounts.propose(firstProposal);
    const second = await accounts.propose({
      ...firstProposal,
      idempotencyKey: "receiving-account-two",
      bankBin: "970415",
      accountNumber: "998877665544",
    });

    expect(second).toMatchObject({
      onboardingId: first.onboardingId,
      version: 2,
      bankBin: "970415",
      bankName: "VietinBank",
      maskedSuffix: "•••• 5544",
      proofState: "unverified",
    });
    expect(second.referenceId).not.toBe(first.referenceId);
    const stored = await client<Pick<StoredAccount, "id" | "version" | "retired_at">[]>`
      select id, version, retired_at from payments_receiving_account_onboarding
      where onboarding_id = ${first.onboardingId}
      order by version
    `;
    expect(stored).toHaveLength(2);
    expect(new Date(stored[0]!.retired_at!).toISOString()).toBe(now.toISOString());
    expect(stored[1]?.retired_at).toBeNull();

    expect(typeof api.createCreatorReceivingAccountReferenceValidator).toBe("function");
    const references = api.createCreatorReceivingAccountReferenceValidator!({ db });
    await expect(
      references.isValidForApplicant({
        applicantUserId: "payments-applicant",
        reference: first.referenceId,
      }),
    ).resolves.toBe(false);
    await expect(
      references.isValidForApplicant({
        applicantUserId: "payments-applicant",
        reference: second.referenceId,
      }),
    ).resolves.toBe(true);
    await expect(
      references.isValidForApplicant({
        applicantUserId: "other-applicant",
        reference: second.referenceId,
      }),
    ).resolves.toBe(false);
  });
});
