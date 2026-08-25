import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  creatorApplicationAttestations,
  creatorApplicationRevisions,
  creatorApplications,
  identityUsers,
  systemCommandIdempotency,
  type PawketDatabase,
} from "@pawket/database";
import { createEncryptionKeyring, hashOpaqueToken } from "@pawket/security";
import {
  CreatorApplicationPolicyError,
  createCanonicalCreatorReceivingAccountReferenceValidator,
  createCreatorApplicationHttpHandlers,
  createCreatorApplicationService as createRawCreatorApplicationService,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database integration tests");

const schemaName = `creator_application_acceptance_${process.pid}_${Date.now()}`;
const client = postgres(databaseUrl, { max: 1 });
const db = drizzle(client) as PawketDatabase;
const migrationsDirectory = new URL("../../database/migrations/", import.meta.url);
const keyring = createEncryptionKeyring({
  activeKeyId: "test-v1",
  keys: { "test-v1": Uint8Array.from({ length: 32 }, (_, index) => index + 1) },
});
const commandFingerprintKey = Uint8Array.from({ length: 32 }, (_, index) => index + 101);
const canonicalReceivingAccountReferences =
  createCanonicalCreatorReceivingAccountReferenceValidator();

type CreatorServiceInput = Parameters<typeof createRawCreatorApplicationService>[0];

function createCreatorApplicationService(
  input: Omit<CreatorServiceInput, "receivingAccountReferences"> &
    Partial<Pick<CreatorServiceInput, "receivingAccountReferences">>,
) {
  return createRawCreatorApplicationService({
    receivingAccountReferences: canonicalReceivingAccountReferences,
    ...input,
  });
}

const completeDraft = {
  artistDisplayName: "Lan Artist",
  shortIntroduction: "Independent illustrator making gentle character art.",
  dateOfBirth: "2000-08-24",
  portfolioUrls: ["https://portfolio.example.com/lan"],
  primaryArtDiscipline: "illustration",
  practiceDescription: "I create digital illustration commissions and personal work.",
  contentIntent: "general_audience_only",
  proposedReceivingAccountId: "a5f6d4bb-2638-4ee1-a847-22f38cd1a2c8",
};

const completeAttestations = {
  dateOfBirthAcknowledged: true,
  truthfulInformationAccepted: true,
  portfolioRightsAccepted: true,
  creatorTermsAccepted: true,
  privacyAccepted: true,
};

async function migrate(filename: string): Promise<void> {
  const migration = await readFile(new URL(filename, migrationsDirectory), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.unsafe(statement);
  }
}

async function createUser(userId: string, verified = true): Promise<void> {
  const at = new Date("2026-08-24T03:00:00.000Z");
  await db.insert(identityUsers).values({
    id: userId,
    name: `${userId} name`,
    email: `${userId}@example.com`,
    canonicalEmail: `${userId}@example.com`,
    emailVerified: verified,
    emailVerifiedAt: verified ? at : null,
    emailVerificationProvenance: verified ? "password_email_challenge" : null,
    createdAt: at,
    updatedAt: at,
  });
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

describe("creator application acceptance", () => {
  test("refuses reapplication before and allows it exactly at rejected_at plus fourteen Vietnam calendar days", async () => {
    // Break caught: trusting a malformed stored cooldown instead of deriving the legal rejected_at boundary.
    const userId = "cooldown-user";
    await createUser(userId);
    const rejectedApplicationId = randomUUID();
    const rejectedRevisionId = randomUUID();
    await db.insert(creatorApplications).values({
      id: rejectedApplicationId,
      userId,
      state: "rejected",
      version: 3,
      currentRevisionId: rejectedRevisionId,
      rejectedAt: new Date("2026-03-01T16:30:00.000Z"),
      // Deliberately late: the applicant boundary must derive the exact legal date from rejectedAt.
      cooldownUntil: new Date("2026-03-15T17:00:00.000Z"),
      createdAt: new Date("2026-02-20T03:00:00.000Z"),
      updatedAt: new Date("2026-03-01T16:30:00.000Z"),
    });
    await db.insert(creatorApplicationRevisions).values({
      id: rejectedRevisionId,
      applicationId: rejectedApplicationId,
      revisionNumber: 1,
      createdAt: new Date("2026-02-20T03:00:00.000Z"),
      updatedAt: new Date("2026-03-01T16:30:00.000Z"),
    });

    let clock = new Date("2026-03-14T16:59:59.999Z");
    const applications = createCreatorApplicationService({ db, keyring, commandFingerprintKey, now: () => clock });
    const command = { userId, idempotencyKey: "cooldown-boundary", ...completeDraft };

    await expect(applications.getForApplicant({ userId })).resolves.toMatchObject({
      state: "rejected",
      cooldownUntil: new Date("2026-03-14T17:00:00.000Z"),
    });
    await expect(applications.saveDraft(command)).rejects.toMatchObject({
      reason: "reapplication_cooldown",
    });
    clock = new Date("2026-03-14T17:00:00.000Z");
    await expect(applications.saveDraft(command)).resolves.toMatchObject({ state: "draft", version: 1 });
  });

  test("concurrent first drafts create one nonterminal application and one safe conflict", async () => {
    // Break caught: a race leaking a raw unique-index error or creating two active applications.
    const userId = "concurrent-create-user";
    await createUser(userId);
    const firstClient = postgres(databaseUrl, { max: 1 });
    const secondClient = postgres(databaseUrl, { max: 1 });
    try {
      await Promise.all([
        firstClient.unsafe(`set search_path to "${schemaName}", public`),
        secondClient.unsafe(`set search_path to "${schemaName}", public`),
      ]);
      const first = createCreatorApplicationService({
        db: drizzle(firstClient) as PawketDatabase,
        keyring,
        commandFingerprintKey,
        now: () => new Date("2026-08-24T03:00:00.000Z"),
      });
      const second = createCreatorApplicationService({
        db: drizzle(secondClient) as PawketDatabase,
        keyring,
        commandFingerprintKey,
        now: () => new Date("2026-08-24T03:00:00.000Z"),
      });

      const outcomes = await Promise.allSettled([
        first.saveDraft({ userId, idempotencyKey: "concurrent-create-a", ...completeDraft }),
        second.saveDraft({ userId, idempotencyKey: "concurrent-create-b", ...completeDraft }),
      ]);
      const diagnostics = outcomes.map((outcome) =>
        outcome.status === "fulfilled"
          ? { status: outcome.status }
          : {
              status: outcome.status,
              message: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
              code: (outcome.reason as { code?: unknown }).code,
              constraint: (outcome.reason as { constraint_name?: unknown }).constraint_name,
            },
      );
      expect(
        outcomes.filter((outcome) => outcome.status === "fulfilled"),
        JSON.stringify(diagnostics),
      ).toHaveLength(1);
      const conflict = outcomes.find((outcome) => outcome.status === "rejected");
      expect(conflict).toMatchObject({
        reason: expect.objectContaining<Partial<CreatorApplicationPolicyError>>({
          reason: "nonterminal_application_exists",
        }),
      });
      const stored = await db
        .select({ id: creatorApplications.id })
        .from(creatorApplications)
        .where(eq(creatorApplications.userId, userId));
      expect(stored).toHaveLength(1);
    } finally {
      await Promise.all([firstClient.end(), secondClient.end()]);
    }
  });

  test("editing an existing draft requires its expected version", async () => {
    // Break caught: a stale browser silently overwriting a newer private draft.
    const userId = "versioned-save-user";
    await createUser(userId);
    const applications = createCreatorApplicationService({
      db,
      keyring,
      commandFingerprintKey,
      now: () => new Date("2026-08-24T03:00:00.000Z"),
    });
    const draft = (await applications.saveDraft({
      userId,
      idempotencyKey: "versioned-save-create",
      ...completeDraft,
    })) as { version: number };
    await expect(
      applications.saveDraft({
        userId,
        idempotencyKey: "versioned-save-missing",
        ...completeDraft,
        shortIntroduction: "A stale update without an expected version.",
      }),
    ).rejects.toMatchObject({ reason: "stale_version" });
    await expect(
      applications.saveDraft({
        userId,
        idempotencyKey: "versioned-save-current",
        expectedVersion: draft.version,
        ...completeDraft,
        shortIntroduction: "A guarded update with the current version.",
      }),
    ).resolves.toMatchObject({
      version: draft.version + 1,
      revision: { shortIntroduction: "A guarded update with the current version." },
    });
  });

  test("submission atomically persists the complete current form instead of a stale saved draft", async () => {
    // Break caught: Submit accepting fresh attestations while silently submitting older saved form fields.
    const userId = "atomic-current-snapshot-user";
    await createUser(userId);
    const applications = createCreatorApplicationService({
      db,
      keyring,
      commandFingerprintKey,
      now: () => new Date("2026-08-24T03:00:00.000Z"),
    });
    const draft = (await applications.saveDraft({
      userId,
      idempotencyKey: "atomic-current-snapshot-draft",
      ...completeDraft,
    })) as { version: number };

    const currentForm = {
      ...completeDraft,
      artistDisplayName: "Lan Current",
      shortIntroduction: "This introduction exists only in the current unsaved form.",
      dateOfBirth: "1999-08-25",
      portfolioUrls: ["https://portfolio.example.com/current"],
      practiceDescription: "This corrected practice statement must be immutable on submission.",
      proposedReceivingAccountId: "2f485fa2-63d7-4f45-945d-e7e268b25b65",
    };
    const submitted = await applications.submit({
      userId,
      idempotencyKey: "atomic-current-snapshot-submit",
      expectedVersion: draft.version,
      ...currentForm,
      ...completeAttestations,
    });

    expect(submitted).toMatchObject({
      state: "submitted",
      revision: {
        revisionNumber: 1,
        artistDisplayName: currentForm.artistDisplayName,
        shortIntroduction: currentForm.shortIntroduction,
        dateOfBirth: currentForm.dateOfBirth,
        portfolioUrls: currentForm.portfolioUrls,
        practiceDescription: currentForm.practiceDescription,
        proposedReceivingAccountId: currentForm.proposedReceivingAccountId,
      },
    });
    expect(JSON.stringify(submitted)).not.toContain(completeDraft.shortIntroduction);
  });

  test("changes requested can directly submit a corrected new immutable revision", async () => {
    // Break caught: direct resubmission mutating revision 1 or requiring an intermediate Save Draft command.
    const userId = "direct-resubmission-user";
    await createUser(userId);
    const applications = createCreatorApplicationService({
      db,
      keyring,
      commandFingerprintKey,
      now: () => new Date("2026-08-24T03:00:00.000Z"),
    });
    const draft = (await applications.saveDraft({
      userId,
      idempotencyKey: "direct-resubmission-draft",
      ...completeDraft,
    })) as { version: number };
    const first = (await applications.submit({
      userId,
      idempotencyKey: "direct-resubmission-first",
      expectedVersion: draft.version,
      ...completeDraft,
      ...completeAttestations,
    })) as { id: string; version: number; revision: { id: string } };
    await db
      .update(creatorApplications)
      .set({ state: "changes_requested", version: first.version + 1 })
      .where(eq(creatorApplications.id, first.id));

    const correctedForm = {
      ...completeDraft,
      artistDisplayName: "Lan Revised",
      dateOfBirth: "1999-08-25",
      portfolioUrls: ["https://portfolio.example.com/revised"],
      proposedReceivingAccountId: "c0d8f48a-dbf2-4674-acac-33c1236e6321",
    };
    const resubmitted = (await applications.submit({
      userId,
      idempotencyKey: "direct-resubmission-second",
      expectedVersion: first.version + 1,
      ...correctedForm,
      ...completeAttestations,
    })) as { revision: { id: string; revisionNumber: number; artistDisplayName: string; dateOfBirth: string } };

    expect(resubmitted.revision).toMatchObject({
      revisionNumber: 2,
      artistDisplayName: correctedForm.artistDisplayName,
      dateOfBirth: correctedForm.dateOfBirth,
    });
    expect(resubmitted.revision.id).not.toBe(first.revision.id);
    const [firstRevision] = await db
      .select({
        artistDisplayName: creatorApplicationRevisions.artistDisplayName,
        submittedAt: creatorApplicationRevisions.submittedAt,
      })
      .from(creatorApplicationRevisions)
      .where(eq(creatorApplicationRevisions.id, first.revision.id));
    expect(firstRevision).toMatchObject({
      artistDisplayName: completeDraft.artistDisplayName,
      submittedAt: new Date("2026-08-24T03:00:00.000Z"),
    });
  });

  test("receiving-account references require applicant-aware port approval before storage", async () => {
    // Break caught: storing a syntactically opaque reference that the Payments boundary refuses for this applicant.
    const ownerId = "receiving-reference-owner";
    const wrongOwnerId = "receiving-reference-wrong-owner";
    const rawAccountId = "receiving-reference-raw-account";
    const approvedReference = "f6a302d9-bb36-44e7-b609-5310aa4fa4bb";
    await createUser(ownerId);
    await createUser(wrongOwnerId);
    await createUser(rawAccountId);
    const canonicalApplications = createCreatorApplicationService({
      db,
      keyring,
      commandFingerprintKey,
      now: () => new Date("2026-08-24T03:00:00.000Z"),
    });
    await expect(
      canonicalApplications.saveDraft({
        userId: rawAccountId,
        idempotencyKey: "receiving-reference-raw-account",
        ...completeDraft,
        proposedReceivingAccountId: "0123456789",
      }),
    ).rejects.toMatchObject({ reason: "invalid_receiving_account_reference" });
    await expect(
      canonicalApplications.getForApplicant({ userId: rawAccountId }),
    ).resolves.toBeNull();
    const receivingAccountReferences = {
      async isValidForApplicant(input: { applicantUserId: string; reference: string }) {
        return input.applicantUserId === ownerId && input.reference === approvedReference;
      },
    };
    const applications = createCreatorApplicationService({
      db,
      keyring,
      commandFingerprintKey,
      receivingAccountReferences,
      now: () => new Date("2026-08-24T03:00:00.000Z"),
    });

    await expect(
      applications.saveDraft({
        userId: wrongOwnerId,
        idempotencyKey: "receiving-reference-refused",
        ...completeDraft,
        proposedReceivingAccountId: approvedReference,
      }),
    ).rejects.toMatchObject({ reason: "invalid_receiving_account_reference" });
    await expect(applications.getForApplicant({ userId: wrongOwnerId })).resolves.toBeNull();

    const approvedDraft = (await applications.saveDraft({
      userId: ownerId,
      idempotencyKey: "receiving-reference-approved-draft",
      ...completeDraft,
      proposedReceivingAccountId: approvedReference,
    })) as { version: number };
    const submitted = await applications.submit({
      userId: ownerId,
      idempotencyKey: "receiving-reference-approved-submit",
      expectedVersion: approvedDraft.version,
      ...completeDraft,
      proposedReceivingAccountId: approvedReference,
      ...completeAttestations,
    });
    expect(submitted).toMatchObject({
      state: "submitted",
      revision: { proposedReceivingAccountId: approvedReference },
    });
  });

  test("submission uses the current verified email and rejects invalid content or a non-opaque account value", async () => {
    // Break caught: accepting an unverified/stale email, invalid content intent, or plaintext account object.
    const unverifiedUserId = "unverified-submit-user";
    await createUser(unverifiedUserId, false);
    const applications = createCreatorApplicationService({
      db,
      keyring,
      commandFingerprintKey,
      now: () => new Date("2026-08-24T03:00:00.000Z"),
    });
    const unverifiedDraft = (await applications.saveDraft({
      userId: unverifiedUserId,
      idempotencyKey: "unverified-draft",
      ...completeDraft,
    })) as { version: number };
    await expect(
      applications.submit({
        userId: unverifiedUserId,
        idempotencyKey: "unverified-submit",
        expectedVersion: unverifiedDraft.version,
        ...completeDraft,
        ...completeAttestations,
      }),
    ).rejects.toMatchObject({ reason: "email_unverified" });

    const invalidContentUserId = "invalid-content-user";
    await createUser(invalidContentUserId);
    const invalidContentDraft = (await applications.saveDraft({
      userId: invalidContentUserId,
      idempotencyKey: "invalid-content-draft",
      ...completeDraft,
      contentIntent: undefined,
    })) as { version: number };
    await expect(
      applications.submit({
        userId: invalidContentUserId,
        idempotencyKey: "invalid-content-submit",
        expectedVersion: invalidContentDraft.version,
        ...completeDraft,
        contentIntent: undefined,
        ...completeAttestations,
      }),
    ).rejects.toMatchObject({ reason: "invalid_content_intent" });

    const accountUserId = "opaque-account-user";
    await createUser(accountUserId);
    const accountDraft = (await applications.saveDraft({
      userId: accountUserId,
      idempotencyKey: "opaque-account-draft",
      ...completeDraft,
      proposedReceivingAccountId: { accountNumber: "0123456789" } as unknown as string,
    })) as { version: number };
    await expect(
      applications.submit({
        userId: accountUserId,
        idempotencyKey: "opaque-account-submit",
        expectedVersion: accountDraft.version,
        ...completeDraft,
        proposedReceivingAccountId: { accountNumber: "0123456789" } as unknown as string,
        ...completeAttestations,
      }),
    ).rejects.toMatchObject({ reason: "incomplete_draft" });
  });

  test("submission requires all five attestations and stores exact server-owned versions at the Vietnam evaluation date", async () => {
    // Break caught: collapsing the DOB acknowledgement or trusting client policy versions/timestamps.
    const userId = "attestation-user";
    await createUser(userId);
    const submittedAt = new Date("2026-08-24T17:30:00.000Z");
    const applications = createCreatorApplicationService({ db, keyring, commandFingerprintKey, now: () => submittedAt });
    const draft = (await applications.saveDraft({
      userId,
      idempotencyKey: "attestation-draft",
      ...completeDraft,
      contentIntent: "may_include_age_restricted",
    })) as { version: number };

    for (const field of Object.keys(completeAttestations) as (keyof typeof completeAttestations)[]) {
      await expect(
        applications.submit({
          userId,
          idempotencyKey: `missing-${field}`,
          expectedVersion: draft.version,
          ...completeDraft,
          contentIntent: "may_include_age_restricted",
          ...completeAttestations,
          [field]: false,
        }),
      ).rejects.toMatchObject({ reason: "missing_attestation" });
    }

    await db
      .update(identityUsers)
      .set({
        email: "current-attestation@example.com",
        canonicalEmail: "current-attestation@example.com",
        updatedAt: submittedAt,
      })
      .where(eq(identityUsers.id, userId));
    const clientControlledSubmission = {
      userId,
      idempotencyKey: "attestation-submit",
      expectedVersion: draft.version,
      ...completeDraft,
      contentIntent: "may_include_age_restricted",
      ...completeAttestations,
      creatorTermsPolicyVersion: "attacker-controlled-version",
      acceptedAt: "1900-01-01T00:00:00.000Z",
    };
    const submitted = (await applications.submit(clientControlledSubmission)) as {
      revision: { id: string };
    };

    const revisionRows = await db
      .select({
        applicantEmail: creatorApplicationRevisions.applicantEmail,
        ageEvaluatedOn: creatorApplicationRevisions.ageEvaluatedOn,
      })
      .from(creatorApplicationRevisions)
      .where(eq(creatorApplicationRevisions.id, submitted.revision.id));
    expect(revisionRows).toEqual([
      { applicantEmail: "current-attestation@example.com", ageEvaluatedOn: "2026-08-25" },
    ]);
    const attestations = await db
      .select({
        type: creatorApplicationAttestations.type,
        policyVersion: creatorApplicationAttestations.policyVersion,
        acceptedAt: creatorApplicationAttestations.acceptedAt,
        actorUserId: creatorApplicationAttestations.actorUserId,
      })
      .from(creatorApplicationAttestations)
      .where(eq(creatorApplicationAttestations.revisionId, submitted.revision.id));
    expect(
      attestations
        .map(({ type, policyVersion }) => [type, policyVersion])
        .sort(([left], [right]) => left!.localeCompare(right!)),
    ).toEqual([
      ["creator_terms", "creator-terms-v1"],
      ["dob_truthfulness", "creator-dob-warning-v1"],
      ["portfolio_rights", "creator-portfolio-rights-v1"],
      ["privacy", "privacy-v1"],
      ["truthful_information", "creator-truthful-information-v1"],
    ]);
    expect(attestations).toHaveLength(5);
    expect(attestations.every((row) => row.acceptedAt.getTime() === submittedAt.getTime())).toBe(true);
    expect(attestations.every((row) => row.actorUserId === userId)).toBe(true);
  });

  test("unrelated applicants cannot infer another application and own reads remain minimized", async () => {
    // Break caught: a user-ID mix-up exposing another applicant, snapshot email, or private review fields.
    const ownerId = "owned-application-user";
    const strangerId = "unrelated-application-user";
    await createUser(ownerId);
    await createUser(strangerId);
    const applications = createCreatorApplicationService({
      db,
      keyring,
      commandFingerprintKey,
      now: () => new Date("2026-08-24T03:00:00.000Z"),
    });
    const owned = (await applications.saveDraft({
      userId: ownerId,
      idempotencyKey: "ownership-draft",
      ...completeDraft,
    })) as Record<string, unknown> & { revision: Record<string, unknown> };

    await expect(applications.getForApplicant({ userId: strangerId })).resolves.toBeNull();
    await expect(
      applications.withdraw({
        userId: strangerId,
        idempotencyKey: "ownership-withdraw",
        expectedVersion: owned.version as number,
      }),
    ).rejects.toMatchObject({ reason: "stale_or_invalid_state" });
    expect(Object.keys(owned)).toEqual(["id", "state", "version", "cooldownUntil", "revision"]);
    expect(Object.keys(owned.revision)).toEqual([
      "id",
      "revisionNumber",
      "artistDisplayName",
      "shortIntroduction",
      "dateOfBirth",
      "portfolioUrls",
      "primaryArtDiscipline",
      "practiceDescription",
      "contentIntent",
      "proposedReceivingAccountId",
      "submittedAt",
    ]);
    expect(JSON.stringify(owned)).not.toContain("owned-application-user@example.com");
    expect(JSON.stringify(owned)).not.toMatch(/admin|private|applicantEmail|ageAtSubmission/u);
  });

  test("submit and withdraw replay stably while conflicting idempotency payloads are rejected", async () => {
    // Break caught: a duplicate submit applying twice or replaying as a later, unrelated aggregate state.
    const userId = "idempotent-command-user";
    await createUser(userId);
    const applications = createCreatorApplicationService({
      db,
      keyring,
      commandFingerprintKey,
      now: () => new Date("2026-08-24T03:00:00.000Z"),
    });
    const draft = (await applications.saveDraft({
      userId,
      idempotencyKey: "idempotent-draft",
      ...completeDraft,
    })) as { version: number };
    const submitCommand = {
      userId,
      idempotencyKey: "idempotent-submit",
      expectedVersion: draft.version,
      ...completeDraft,
      ...completeAttestations,
    };
    const submitted = (await applications.submit(submitCommand)) as { id: string; version: number };
    await expect(applications.submit(submitCommand)).resolves.toEqual(submitted);
    await expect(
      applications.submit({ ...submitCommand, privacyAccepted: false }),
    ).rejects.toMatchObject({ reason: "idempotency_conflict" });

    const withdrawCommand = {
      userId,
      idempotencyKey: "idempotent-withdraw",
      expectedVersion: submitted.version,
    };
    const withdrawn = await applications.withdraw(withdrawCommand);
    await expect(applications.withdraw(withdrawCommand)).resolves.toEqual(withdrawn);
    await expect(applications.submit(submitCommand)).resolves.toEqual(submitted);

    const events = await client<{ event_type: string; payload: Record<string, unknown> }[]>`
      select event_type, payload from system_outbox where aggregate_id = ${submitted.id} order by event_type
    `;
    expect(events).toEqual([
      {
        event_type: "creator.application.submitted.v1",
        payload: {
          applicationId: submitted.id,
          state: "submitted",
          version: 2,
          correlationId: submitted.id,
        },
      },
      {
        event_type: "creator.application.withdrawn.v1",
        payload: {
          applicationId: submitted.id,
          state: "withdrawn",
          version: 3,
          correlationId: submitted.id,
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/2000-08-24|example\.com|portfolio|receiving/u);
  });

  test("stores a keyed creator-command fingerprint that raw candidate data cannot reproduce", async () => {
    // Break caught: persisting an unkeyed digest of DOB, portfolio query, and receiving reference that an offline attacker can enumerate.
    const userId = "keyed-command-fingerprint-user";
    await createUser(userId);
    const applications = createCreatorApplicationService({
      db,
      keyring,
      commandFingerprintKey,
      now: () => new Date("2026-08-24T03:00:00.000Z"),
    });
    const command = {
      userId,
      idempotencyKey: "keyed-command-fingerprint-draft",
      ...completeDraft,
      dateOfBirth: "2000-08-24",
      portfolioUrls: ["https://portfolio.example/lan?private=not-for-storage"],
      proposedReceivingAccountId: "79fe922e-6d40-4d0a-bb67-9aca093aee2d",
    };
    const saved = await applications.saveDraft(command);
    await expect(applications.saveDraft(command)).resolves.toEqual(saved);
    await expect(
      applications.saveDraft({ ...command, artistDisplayName: "Conflicting payload" }),
    ).rejects.toMatchObject({ reason: "idempotency_conflict" });

    const [stored] = await db
      .select({ requestFingerprint: systemCommandIdempotency.requestFingerprint })
      .from(systemCommandIdempotency)
      .where(eq(systemCommandIdempotency.actorUserId, userId));
    expect(stored?.requestFingerprint).toBeDefined();
    const legacyOfflineFingerprint = hashOpaqueToken(
      JSON.stringify({ ...command, idempotencyKey: undefined }),
      "creator-request",
    );
    expect(stored?.requestFingerprint).not.toBe(legacyOfflineFingerprint);
  });

  test("concurrent submit and withdraw with one expected version yield one winner and one domain conflict", async () => {
    // Break caught: both transitions committing, neither committing, or a raw database race escaping.
    const userId = "concurrent-transition-user";
    await createUser(userId);
    const setup = createCreatorApplicationService({
      db,
      keyring,
      commandFingerprintKey,
      now: () => new Date("2026-08-24T03:00:00.000Z"),
    });
    const draft = (await setup.saveDraft({
      userId,
      idempotencyKey: "concurrent-transition-draft",
      ...completeDraft,
    })) as { version: number };
    const firstClient = postgres(databaseUrl, { max: 1 });
    const secondClient = postgres(databaseUrl, { max: 1 });
    try {
      await Promise.all([
        firstClient.unsafe(`set search_path to "${schemaName}", public`),
        secondClient.unsafe(`set search_path to "${schemaName}", public`),
      ]);
      const submitter = createCreatorApplicationService({
        db: drizzle(firstClient) as PawketDatabase,
        keyring,
        commandFingerprintKey,
        now: () => new Date("2026-08-24T03:01:00.000Z"),
      });
      const withdrawer = createCreatorApplicationService({
        db: drizzle(secondClient) as PawketDatabase,
        keyring,
        commandFingerprintKey,
        now: () => new Date("2026-08-24T03:01:00.000Z"),
      });
      const outcomes = await Promise.allSettled([
        submitter.submit({
          userId,
          idempotencyKey: "concurrent-transition-submit",
          expectedVersion: draft.version,
          ...completeDraft,
          ...completeAttestations,
        }),
        withdrawer.withdraw({
          userId,
          idempotencyKey: "concurrent-transition-withdraw",
          expectedVersion: draft.version,
        }),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      const conflict = outcomes.find((outcome) => outcome.status === "rejected");
      expect(conflict).toMatchObject({
        reason: expect.objectContaining<Partial<CreatorApplicationPolicyError>>({
          reason: "stale_or_invalid_state",
        }),
      });
      const current = (await setup.getForApplicant({ userId })) as { state: string; version: number };
      expect(["submitted", "withdrawn"]).toContain(current.state);
      expect(current.version).toBe(draft.version + 1);
    } finally {
      await Promise.all([firstClient.end(), secondClient.end()]);
    }
  });

  test("PostgreSQL rejects both UPDATE and DELETE of a submitted revision", async () => {
    // Break caught: a trigger that protects updates but accidentally permits destructive deletion.
    const userId = "immutable-delete-user";
    await createUser(userId);
    const applications = createCreatorApplicationService({
      db,
      keyring,
      commandFingerprintKey,
      now: () => new Date("2026-08-24T03:00:00.000Z"),
    });
    const draft = (await applications.saveDraft({
      userId,
      idempotencyKey: "immutable-delete-draft",
      ...completeDraft,
    })) as { version: number };
    const submitted = (await applications.submit({
      userId,
      idempotencyKey: "immutable-delete-submit",
      expectedVersion: draft.version,
      ...completeDraft,
      ...completeAttestations,
    })) as { revision: { id: string } };

    await expect(
      client`update creator_application_revisions set artist_display_name = 'changed' where id = ${submitted.revision.id}`,
    ).rejects.toThrow("submitted creator application revisions are immutable");
    await expect(
      client`delete from creator_application_revisions where id = ${submitted.revision.id}`,
    ).rejects.toThrow("submitted creator application revisions are immutable");
  });

  test("PostgreSQL rejects both UPDATE and DELETE of attestations for a submitted revision", async () => {
    // Break caught: changing or deleting the consent evidence after an application has been submitted.
    const userId = "immutable-attestation-user";
    await createUser(userId);
    const applications = createCreatorApplicationService({
      db,
      keyring,
      commandFingerprintKey,
      now: () => new Date("2026-08-24T03:00:00.000Z"),
    });
    const draft = (await applications.saveDraft({
      userId,
      idempotencyKey: "immutable-attestation-draft",
      ...completeDraft,
    })) as { version: number };
    const submitted = (await applications.submit({
      userId,
      idempotencyKey: "immutable-attestation-submit",
      expectedVersion: draft.version,
      ...completeDraft,
      ...completeAttestations,
    })) as { revision: { id: string } };
    const [attestation] = await db
      .select({ id: creatorApplicationAttestations.id })
      .from(creatorApplicationAttestations)
      .where(eq(creatorApplicationAttestations.revisionId, submitted.revision.id));

    await expect(
      client`update creator_application_attestations set policy_version = 'changed' where id = ${attestation!.id}`,
    ).rejects.toThrow("submitted creator application attestations are immutable");
    await expect(
      client`delete from creator_application_attestations where id = ${attestation!.id}`,
    ).rejects.toThrow("submitted creator application attestations are immutable");
  });

  test("PostgreSQL rejects inserting an attestation into a submitted revision", async () => {
    // Break caught: backfilling a missing attestation type into a legacy submitted snapshot.
    const userId = "submitted-attestation-insert-user";
    const applicationId = randomUUID();
    const revisionId = randomUUID();
    const at = new Date("2026-08-24T03:00:00.000Z");
    await createUser(userId);
    await db.insert(creatorApplications).values({
      id: applicationId,
      userId,
      state: "submitted",
      version: 2,
      currentRevisionId: revisionId,
      createdAt: at,
      updatedAt: at,
    });
    await db.insert(creatorApplicationRevisions).values({
      id: revisionId,
      applicationId,
      revisionNumber: 1,
      submittedAt: at,
      createdAt: at,
      updatedAt: at,
    });
    await expect(
      client`insert into creator_application_attestations (id, revision_id, type, policy_version, accepted_at, actor_user_id) values (${randomUUID()}, ${revisionId}, ${"privacy"}, ${"privacy-v1"}, ${at.toISOString()}, ${userId})`,
    ).rejects.toThrow("submitted creator application attestations are immutable");
  });

  test("PostgreSQL rejects moving an attestation into a submitted revision while draft rows remain mutable", async () => {
    // Break caught: an UPDATE bypassing OLD-only trigger checks to attach a draft attestation to a submitted snapshot.
    const userId = "submitted-attestation-move-user";
    const applicationId = randomUUID();
    const submittedRevisionId = randomUUID();
    const draftRevisionId = randomUUID();
    const attestationId = randomUUID();
    const at = new Date("2026-08-24T03:00:00.000Z");
    await createUser(userId);
    await db.insert(creatorApplications).values({
      id: applicationId,
      userId,
      state: "submitted",
      version: 2,
      currentRevisionId: submittedRevisionId,
      createdAt: at,
      updatedAt: at,
    });
    await db.insert(creatorApplicationRevisions).values([
      { id: submittedRevisionId, applicationId, revisionNumber: 1, submittedAt: at, createdAt: at, updatedAt: at },
      { id: draftRevisionId, applicationId, revisionNumber: 2, createdAt: at, updatedAt: at },
    ]);
    await db.insert(creatorApplicationAttestations).values({
      id: attestationId,
      revisionId: draftRevisionId,
      type: "privacy",
      policyVersion: "privacy-v1",
      acceptedAt: at,
      actorUserId: userId,
    });
    await expect(
      db.update(creatorApplicationAttestations)
        .set({ policyVersion: "privacy-v2" })
        .where(eq(creatorApplicationAttestations.id, attestationId)),
    ).resolves.toBeDefined();
    await expect(
      client`update creator_application_attestations set revision_id = ${submittedRevisionId} where id = ${attestationId}`,
    ).rejects.toThrow("submitted creator application attestations are immutable");
    await expect(
      db.delete(creatorApplicationAttestations).where(eq(creatorApplicationAttestations.id, attestationId)),
    ).resolves.toBeDefined();
  });

  test("migration 0008 upgrades submitted attestation rows without rewriting migration history", async () => {
    // Break caught: applying the additive migration only on empty databases or leaving pre-existing submitted evidence mutable.
    const upgradeSchema = `creator_attestation_upgrade_${process.pid}_${Date.now()}`;
    const userId = `upgrade-user-${Date.now()}`;
    const applicationId = randomUUID();
    const revisionId = randomUUID();
    const attestationId = randomUUID();
    const at = new Date("2026-08-24T03:00:00.000Z");
    try {
      await client.unsafe(`create schema "${upgradeSchema}"`);
      await client.unsafe(`set search_path to "${upgradeSchema}", public`);
      for (const filename of (await readdir(migrationsDirectory)).filter(
        (entry) => entry.endsWith(".sql") && entry <= "0007_creator-applications.sql",
      ).sort()) {
        await migrate(filename);
      }
      await db.insert(identityUsers).values({
        id: userId,
        name: "Upgrade User",
        email: "upgrade@example.com",
        canonicalEmail: "upgrade@example.com",
        emailVerified: true,
        emailVerifiedAt: at,
        emailVerificationProvenance: "password_email_challenge",
        createdAt: at,
        updatedAt: at,
      });
      // Keep this pre-0008 fixture versioned: the current Drizzle model also
      // contains review-claim columns introduced by migration 0013.
      await client`
        insert into creator_applications (
          id, user_id, state, version, current_revision_id, created_at, updated_at
        ) values (${applicationId}, ${userId}, 'submitted', 2, ${revisionId}, ${at.toISOString()}, ${at.toISOString()})
      `;
      await db.insert(creatorApplicationRevisions).values({
        id: revisionId,
        applicationId,
        revisionNumber: 1,
        submittedAt: at,
        createdAt: at,
        updatedAt: at,
      });
      await db.insert(creatorApplicationAttestations).values({
        id: attestationId,
        revisionId,
        type: "privacy",
        policyVersion: "privacy-v1",
        acceptedAt: at,
        actorUserId: userId,
      });

      await migrate("0008_creator-application-attestation-immutability.sql");
      await expect(
        client`insert into creator_application_attestations (id, revision_id, type, policy_version, accepted_at, actor_user_id) values (${randomUUID()}, ${revisionId}, ${"creator_terms"}, ${"creator-terms-v1"}, ${at.toISOString()}, ${userId})`,
      ).rejects.toThrow("submitted creator application attestations are immutable");
      await expect(
        client`update creator_application_attestations set policy_version = 'changed' where id = ${attestationId}`,
      ).rejects.toThrow("submitted creator application attestations are immutable");
      await expect(
        client`delete from creator_application_attestations where id = ${attestationId}`,
      ).rejects.toThrow("submitted creator application attestations are immutable");
    } finally {
      await client.unsafe("set search_path to public");
      await client.unsafe(`drop schema if exists "${upgradeSchema}" cascade`);
      await client.unsafe(`set search_path to "${schemaName}", public`);
    }
  });

  test("HTTP commands enforce POST, exact origin and JSON, canonical If-Match, and idempotency", async () => {
    // Break caught: a CSRFable, stale, replay-unsafe, or method-confused browser command.
    const userId = "http-command-user";
    await createUser(userId);
    const service = createCreatorApplicationService({
      db,
      keyring,
      commandFingerprintKey,
      now: () => new Date("2026-08-24T03:00:00.000Z"),
    });
    const draft = (await service.saveDraft({
      userId,
      idempotencyKey: "http-command-draft",
      ...completeDraft,
    })) as { version: number };
    const origin = "https://pawket.example";
    const handlers = createCreatorApplicationHttpHandlers({
      trustedOrigins: [origin],
      authenticate: async () => ({ userId }),
      service,
    });
    const submitBody = JSON.stringify({ ...completeDraft, ...completeAttestations });
    const request = (headers: Record<string, string>, method = "POST") =>
      new Request(`${origin}/api/v1/creator-application/submit`, {
        method,
        headers,
        ...(method === "POST" ? { body: submitBody } : {}),
      });

    expect((await handlers.submit(request({ origin }, "GET"))).status).toBe(405);
    expect(
      (await handlers.submit(request({ "content-type": "application/json" }))).status,
    ).toBe(403);
    expect(
      (
        await handlers.submit(
          request({ origin: "https://pawket.example.evil.test", "content-type": "application/json" }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handlers.submit(
          request({ origin, "content-type": "text/plain", "idempotency-key": "http-submit", "if-match": String(draft.version) }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handlers.submit(
          request({ origin, "content-type": "application/json", "if-match": String(draft.version) }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handlers.submit(
          request({ origin, "content-type": "application/json", "idempotency-key": "http-submit" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handlers.submit(
          request({
            origin,
            "content-type": "application/json",
            "idempotency-key": "http-submit",
            "if-match": `0${draft.version}`,
          }),
        )
      ).status,
    ).toBe(400);

    const submitted = await handlers.submit(
      request({
        origin,
        "content-type": "application/json",
        "idempotency-key": "http-submit",
        "if-match": String(draft.version),
      }),
    );
    expect(submitted.status).toBe(200);
    expect(submitted.headers.get("cache-control")).toBe("no-store");
    expect(submitted.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await submitted.json()).toMatchObject({
      application: { state: "submitted", version: draft.version + 1 },
    });
  });

  test("HTTP resolves the authoritative current user and returns only safe own-application shapes", async () => {
    // Break caught: trusting a body userId, disclosing a victim application, or returning policy reasons/private fields.
    const actorId = "http-authoritative-user";
    const victimId = "http-victim-user";
    await createUser(actorId);
    await createUser(victimId);
    const service = createCreatorApplicationService({
      db,
      keyring,
      commandFingerprintKey,
      now: () => new Date("2026-08-24T03:00:00.000Z"),
    });
    const origin = "https://pawket.example";
    const actorHandlers = createCreatorApplicationHttpHandlers({
      trustedOrigins: [origin],
      authenticate: async () => ({ userId: actorId }),
      service,
    });
    const anonymousHandlers = createCreatorApplicationHttpHandlers({
      trustedOrigins: [origin],
      authenticate: async () => null,
      service,
    });
    const saved = await actorHandlers.save(
      new Request(`${origin}/api/v1/creator-application`, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          "idempotency-key": "http-authoritative-draft",
        },
        body: JSON.stringify({ ...completeDraft, userId: victimId }),
      }),
    );
    expect(saved.status).toBe(200);
    expect(await service.getForApplicant({ userId: victimId })).toBeNull();
    expect(await service.getForApplicant({ userId: actorId })).toMatchObject({ state: "draft" });

    const bodyControlledVersion = await actorHandlers.save(
      new Request(`${origin}/api/v1/creator-application`, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          "idempotency-key": "http-body-version-draft",
        },
        body: JSON.stringify({ ...completeDraft, expectedVersion: 1 }),
      }),
    );
    expect(bodyControlledVersion.status).toBe(422);
    await expect(service.getForApplicant({ userId: actorId })).resolves.toMatchObject({
      version: 1,
    });

    expect(
      (await anonymousHandlers.get(new Request(`${origin}/api/v1/creator-application`))).status,
    ).toBe(401);
    const own = await actorHandlers.get(new Request(`${origin}/api/v1/creator-application`));
    expect(own.status).toBe(200);
    const ownJson = (await own.json()) as Record<string, unknown>;
    expect(Object.keys(ownJson)).toEqual(["application"]);
    expect(JSON.stringify(ownJson)).not.toMatch(/http-authoritative-user@example\.com|admin|private|applicantEmail/u);

    const policyError = await actorHandlers.submit(
      new Request(`${origin}/api/v1/creator-application/submit`, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          "idempotency-key": "http-policy-error",
          "if-match": "1",
        },
        body: JSON.stringify({
          ...completeDraft,
          ...completeAttestations,
          privacyAccepted: false,
        }),
      }),
    );
    expect(policyError.status).toBe(422);
    expect(await policyError.json()).toEqual({ code: "POLICY_REJECTED" });
  });
});
