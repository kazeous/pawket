import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import * as schema from "@pawket/database";
import { type PawketDatabase } from "@pawket/database";

import * as admin from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for admin integration tests");

const schemaName = `admin_creator_review_${process.pid}_${Date.now()}`;
const client = postgres(databaseUrl, { max: 5, connection: { search_path: `${schemaName},public` } });
const db = drizzle(client, { schema }) as PawketDatabase;
const migrationsDirectory = new URL("../../database/migrations/", import.meta.url);
const now = new Date("2026-08-25T03:00:00.000Z");
const at = now.toISOString();
const challengeExpiresAt = new Date(now.getTime() + 72 * 60 * 60_000).toISOString();
const applicationId = "10000000-0000-4000-8000-000000000001";
const revisionId = "10000000-0000-4000-8000-000000000002";
const accountVersionId = "10000000-0000-4000-8000-000000000003";
const challengeId = "10000000-0000-4000-8000-000000000004";
const receiptId = "10000000-0000-4000-8000-000000000005";
const obligationId = "10000000-0000-4000-8000-000000000006";
const proofId = "10000000-0000-4000-8000-000000000007";

async function executeMigration(filename: string): Promise<void> {
  const migration = await readFile(new URL(filename, migrationsDirectory), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.unsafe(statement);
  }
}

async function seedSubmittedApplication(): Promise<void> {
  await client`
    insert into identity_users (
      id, name, email, canonical_email, email_verified, email_verified_at,
      email_verification_provenance, access_status, authorization_version, created_at, updated_at
    ) values
      ('review-owner', 'Owner', 'owner@pawket.test', 'owner@pawket.test', true, ${at},
       'password_email_challenge', 'active', 1, ${at}, ${at}),
      ('review-artist', 'Artist', 'artist@pawket.test', 'artist@pawket.test', true, ${at},
       'password_email_challenge', 'active', 1, ${at}, ${at})
  `;
  await client`
    insert into creator_applications (
      id, user_id, state, version, current_revision_id, created_at, updated_at
    ) values (${applicationId}, 'review-artist', 'submitted', 2, ${revisionId}, ${at}, ${at})
  `;
  await client`
    insert into creator_application_revisions (
      id, application_id, revision_number, artist_display_name, applicant_email,
      portfolio_urls, primary_art_discipline, content_intent, proposed_receiving_account_id,
      age_at_submission, age_evaluated_on, submitted_at, created_at, updated_at
    ) values (
      ${revisionId}, ${applicationId}, 1, 'Test Artist', 'artist@pawket.test',
      ${JSON.stringify(["https://portfolio.example/artist"]) }::jsonb, 'illustration',
      'general_audience_only', ${accountVersionId}, 23, '2026-08-25', null, ${at}, ${at}
    )
  `;
  for (const type of [
    "dob_truthfulness",
    "portfolio_rights",
    "truthful_information",
    "creator_terms",
    "privacy",
  ]) {
    await client`
      insert into creator_application_attestations (id, revision_id, type, policy_version, accepted_at, actor_user_id)
      values (${randomUUID()}, ${revisionId}, ${type}, 'increment-2-v1', ${at}, 'review-artist')
    `;
  }
  await client`
    update creator_application_revisions set submitted_at = ${at}, updated_at = ${at}
    where id = ${revisionId}
  `;
  await client`
    insert into payments_receiving_account_onboarding (
      id, onboarding_id, applicant_user_id, version, bank_bin, bank_name,
      account_number_envelope, account_holder_label_envelope, masked_suffix, account_fingerprint,
      proof_state, proof_verified_at, created_at, updated_at
    ) values (
      ${accountVersionId}, '10000000-0000-4000-8000-000000000008', 'review-artist', 1,
      '970436', 'Vietcombank', '{}'::jsonb, '{}'::jsonb, '•••• 7890',
      'hmac-sha256:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'verified', ${at}, ${at}, ${at}
    )
  `;
  await client`
    insert into payments_verification_deposit_challenges (
      id, application_id, revision_id, account_version_id, amount_vnd, reference_hash, state,
      issued_by_owner_user_id, step_up_proof_id, issued_at, expires_at, verified_at, created_at, updated_at
    ) values (
      ${challengeId}, ${applicationId}, ${revisionId}, ${accountVersionId}, 20000,
      'sha256:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'verified', 'review-owner', ${proofId},
      ${at}, ${challengeExpiresAt}, ${at}, ${at}, ${at}
    )
  `;
  await client`
    insert into payments_verification_deposit_receipts (
      id, challenge_id, bank_transaction_fingerprint, actual_amount_vnd, actual_reference_hash,
      received_at, source_bank_bin, source_account_fingerprint, source_masked_suffix, private_note,
      result, reconciled_by_owner_user_id, owner_session_id, step_up_proof_id, request_id, created_at
    ) values (
      ${receiptId}, ${challengeId}, 'hmac-sha256:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 20000,
      'sha256:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ${at}, '970436',
      'hmac-sha256:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '•••• 7890', 'matched', 'matched',
      'review-owner', 'owner-session', ${proofId}, 'seed-request', ${at}
    )
  `;
  await client`
    insert into system_business_calendar_versions (version, source_label, published_at, imported_at)
    values ('vn-2026', 'test', ${at}, ${at})
  `;
  await client`
    insert into payments_verification_deposit_refund_obligations (
      id, receipt_id, challenge_id, account_version_id, applicant_user_id, amount_vnd,
      locked_bank_bin, locked_bank_name, locked_account_number_envelope, locked_account_holder_label_envelope,
      locked_masked_suffix, locked_account_fingerprint, calendar_version, receipt_date,
      refund_not_before, refund_due, state, created_at, updated_at
    ) values (
      ${obligationId}, ${receiptId}, ${challengeId}, ${accountVersionId}, 'review-artist', 20000,
      '970436', 'Vietcombank', '{}'::jsonb, '{}'::jsonb, '•••• 7890',
      'hmac-sha256:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'vn-2026', '2026-08-25',
      '2026-09-01', '2026-09-03', 'pending_window', ${at}, ${at}
    )
  `;
}

beforeAll(async () => {
  await client.unsafe(`create schema if not exists "${schemaName}"`);
  const migrations = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort();
  for (const migration of migrations) await executeMigration(migration);
});

beforeEach(async () => {
  const tables = await client<{ tablename: string }[]>`
    select tablename from pg_tables where schemaname = ${schemaName}
  `;
  for (const { tablename } of tables) await client.unsafe(`truncate table "${schemaName}"."${tablename}" cascade`);
  await seedSubmittedApplication();
});

afterAll(async () => {
  await client.unsafe(`drop schema if exists "${schemaName}" cascade`);
  await client.end();
});

describe("owner creator review", () => {
  test("approval atomically records the decision, grants creator capability, refreshes authorization, audits, and emits safe facts", async () => {
    // Break caught: approval that changes application state without every required capability, audit, authorization, and outbox fact.
    type Factory = {
      createCreatorReviewService(input: Record<string, unknown>): {
        claim(input: Record<string, unknown>): Promise<{ version: number }>;
        decide(input: Record<string, unknown>): Promise<{ state: string }>;
      };
    };
    const api = admin as unknown as Partial<Factory>;
    expect(typeof api.createCreatorReviewService).toBe("function");
    const service = api.createCreatorReviewService!({
      db,
      commandFingerprintKey: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
      now: () => now,
      consumeStepUpProof: async () => true,
    });

    const claimed = await service.claim({
      ownerUserId: "review-owner",
      ownerSessionId: "owner-session",
      applicationId,
      expectedVersion: 2,
      requestId: "claim-request",
    });
    const result = await service.decide({
      ownerUserId: "review-owner",
      ownerSessionId: "owner-session",
      stepUpProofId: proofId,
      applicationId,
      revisionId,
      expectedVersion: claimed.version,
      idempotencyKey: "approve-creator-one",
      requestId: "approve-request",
      action: "approve",
      reasonCode: "portfolio_insufficient",
      applicantExplanation: "Portfolio review is complete.",
    });

    expect(result).toEqual({ state: "approved" });
    const [facts] = await client<{
      application_state: string;
      capabilities: number;
      authorization_version: number;
      decisions: number;
      audits: number;
      outbox: number;
    }[]>`
      select
        (select state from creator_applications where id = ${applicationId}) as application_state,
        (select count(*)::int from identity_creator_capabilities where user_id = 'review-artist' and state = 'active') as capabilities,
        (select authorization_version from identity_users where id = 'review-artist') as authorization_version,
        (select count(*)::int from creator_application_decisions where application_id = ${applicationId} and action = 'approved') as decisions,
        (select count(*)::int from admin_audit_events where action = 'creator.application.approve') as audits,
        (select count(*)::int from system_outbox where aggregate_id = ${applicationId}) as outbox
    `;
    expect(facts).toEqual({
      application_state: "approved",
      capabilities: 1,
      authorization_version: 2,
      decisions: 1,
      audits: 1,
      outbox: 2,
    });
  });

  test("suspension and reinstatement compensate capability without rewriting the approval decision", async () => {
    // Break caught: suspension deleting approval history, leaving existing authorization current, or changing buyer account status.
    type Factory = {
      createCreatorReviewService(input: Record<string, unknown>): {
        claim(input: Record<string, unknown>): Promise<{ version: number }>;
        decide(input: Record<string, unknown>): Promise<{ state: string }>;
        setCreatorCapability(input: Record<string, unknown>): Promise<{ state: string }>;
      };
    };
    const api = admin as unknown as Partial<Factory>;
    expect(typeof api.createCreatorReviewService).toBe("function");
    const service = api.createCreatorReviewService!({
      db,
      commandFingerprintKey: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
      now: () => now,
      consumeStepUpProof: async () => true,
    });
    const claimed = await service.claim({ ownerUserId: "review-owner", ownerSessionId: "owner-session", applicationId, expectedVersion: 2, requestId: "claim-suspend-request" });
    await service.decide({ ownerUserId: "review-owner", ownerSessionId: "owner-session", stepUpProofId: proofId, applicationId, revisionId, expectedVersion: claimed.version, idempotencyKey: "approve-before-suspend", requestId: "approve-before-suspend-request", action: "approve", reasonCode: "other", applicantExplanation: "Approved." });

    expect(typeof service.setCreatorCapability).toBe("function");
    await expect(service.setCreatorCapability({
      ownerUserId: "review-owner", ownerSessionId: "owner-session", stepUpProofId: "10000000-0000-4000-8000-000000000009",
      userId: "review-artist", action: "suspend", reasonCode: "other", applicantExplanation: "Creator access is temporarily suspended.",
      idempotencyKey: "suspend-creator-one", requestId: "suspend-request",
    })).resolves.toEqual({ state: "suspended" });
    const [suspended] = await client<{ capability: string; decisions: number; access_status: string; authorization_version: number }[]>`
      select
        (select state from identity_creator_capabilities where user_id = 'review-artist') as capability,
        (select count(*)::int from creator_application_decisions where application_id = ${applicationId} and action = 'approved') as decisions,
        (select access_status from identity_users where id = 'review-artist') as access_status,
        (select authorization_version from identity_users where id = 'review-artist') as authorization_version
    `;
    expect(suspended).toEqual({ capability: "suspended", decisions: 1, access_status: "active", authorization_version: 3 });
    await expect(service.setCreatorCapability({
      ownerUserId: "review-owner", ownerSessionId: "owner-session", stepUpProofId: "10000000-0000-4000-8000-000000000010",
      userId: "review-artist", action: "reinstate", reasonCode: "other", applicantExplanation: "Creator access is restored.",
      idempotencyKey: "reinstate-creator-one", requestId: "reinstate-request",
    })).resolves.toEqual({ state: "active" });
  });
});
